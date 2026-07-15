/**
 * omp-rewind — OMP extension entry point.
 *
 * Binds git workspace checkpoints to session-tree entry IDs so OMP's native
 * double-Esc tree navigation restores conversation and files together.
 *
 * All checkpoint data lives in a SHADOW git dir under the extension cache;
 * the workspace's own .git is never polluted (no refs, no objects).
 *
 * Checkpoint schedule (granularity "tool", the default):
 *   - before each agent turn  → ref bound to the current leaf entry
 *   - after each mutating tool → ref bound to the just-persisted entry
 * `OMP_REWIND_GRANULARITY=turn` drops the per-tool refs.
 *
 * Restore semantics (the contract):
 *   - navigation target resolves to the nearest self-or-ancestor checkpoint
 *   - worktree files + staged/unstaged split; HEAD and branch never move
 *   - before restoring, the leaving state is checkpointed against the old
 *     leaf, so undo = navigate back to the node you came from
 */

import {
	type CheckpointMeta,
	countSessionCheckpoints,
	createCheckpoint,
	diffTreeStat,
	git,
	listCheckpointRefs,
	loadCheckpoint,
	openShadow,
	pruneCheckpoints,
	READ_ONLY_TOOLS,
	refComponent,
	RestoreBlockedError,
	restoreCheckpoint,
	type ShadowRepo,
} from "./core.ts";
import type {
	BeforeTreeResult,
	ExtensionContextLike,
	PiApiLike,
	SessionEntryLike,
	TreePreparationLike,
} from "./types.ts";

const STATUS_KEY = "omp-rewind";
/** Entry-ID stand-in for the empty tree (leaf = null). */
const ROOT_ENTRY = "root";

interface PendingRestore {
	mode: "all" | "conversation";
	checkpoint: CheckpointMeta | null;
}

interface State {
	shadow: ShadowRepo | null;
	sessionId: string;
	granularity: "tool" | "turn";
	/** Decision taken in session_before_tree, executed in session_tree. */
	pending: PendingRestore | null;
	/** Serializes checkpoint creation; restore waits for it. */
	writing: Promise<void>;
	busy: boolean;
	/** This session spawned subagents — restore dialogs warn about races. */
	sawTask: boolean;
}

function isUserish(entry: SessionEntryLike | undefined): boolean {
	if (!entry) return false;
	if (entry.type === "custom_message") return true;
	const role = entry.role ?? entry.message?.role;
	return entry.type === "message" && role === "user";
}

export default function (pi: PiApiLike) {
	const state: State = {
		shadow: null,
		sessionId: "",
		granularity:
			process.env.OMP_REWIND_GRANULARITY === "turn" ? "turn" : "tool",
		pending: null,
		writing: Promise.resolve(),
		busy: false,
		sawTask: false,
	};

	const updateStatus = async (ctx: ExtensionContextLike): Promise<void> => {
		if (!ctx.hasUI) return;
		if (!state.shadow) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const count = await countSessionCheckpoints(state.shadow, state.sessionId);
		ctx.ui.setStatus(
			STATUS_KEY,
			`◆ ${count} checkpoint${count === 1 ? "" : "s"}`,
		);
	};

	/** Queue a checkpoint write; failures are logged, never thrown. */
	const scheduleCheckpoint = (
		ctx: ExtensionContextLike,
		entryId: string,
		label: string,
	): Promise<void> => {
		const shadow = state.shadow;
		if (!shadow) return Promise.resolve();
		const run = state.writing.then(async () => {
			try {
				await createCheckpoint({
					shadow,
					sessionId: state.sessionId,
					entryId,
					label,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				pi.logger?.warn?.(`omp-rewind: checkpoint failed: ${message}`);
			}
		});
		state.writing = run;
		return run.then(() => updateStatus(ctx));
	};

	const currentLeafEntry = (ctx: ExtensionContextLike): string => {
		const entries = ctx.sessionManager.getBranch();
		return entries.at(-1)?.id ?? ROOT_ENTRY;
	};

	/**
	 * The leaf the session will have after navigating to `targetId`:
	 * user/custom messages move the leaf to their parent, everything else
	 * becomes the leaf itself (mirrors OMP's navigateTree rules).
	 */
	const effectiveNewLeaf = (
		ctx: ExtensionContextLike,
		targetId: string,
	): string | null => {
		const entry = ctx.sessionManager.getEntry(targetId);
		if (!entry) return targetId;
		return isUserish(entry) ? entry.parentId : targetId;
	};

	/**
	 * Nearest self-or-ancestor entry of `leafId` that has a checkpoint.
	 * Returns the checkpoint plus whether it is exact (bound to leaf itself).
	 */
	const findRestorePoint = async (
		shadow: ShadowRepo,
		ctx: ExtensionContextLike,
		leafId: string | null,
	): Promise<{ checkpoint: CheckpointMeta; exact: boolean } | null> => {
		const session = refComponent(state.sessionId);
		const available = new Set<string>();
		for (const listing of await listCheckpointRefs(shadow)) {
			if (listing.sessionComponent === session) {
				available.add(listing.entryComponent);
			}
		}
		if (available.size === 0) return null;

		const chain: string[] =
			leafId === null
				? [ROOT_ENTRY]
				: [
						...ctx.sessionManager
							.getBranch(leafId)
							.map((entry) => entry.id)
							.reverse(),
						ROOT_ENTRY,
					];

		for (const entryId of chain) {
			if (!available.has(refComponent(entryId))) continue;
			const checkpoint = await loadCheckpoint(shadow, state.sessionId, entryId);
			if (checkpoint) {
				return { checkpoint, exact: entryId === (leafId ?? ROOT_ENTRY) };
			}
		}
		return null;
	};

	const waitForIdle = async (ctx: ExtensionContextLike): Promise<boolean> => {
		if (ctx.isIdle?.() !== false) return true;
		await ctx.abort?.();
		for (let i = 0; i < 50; i++) {
			if (ctx.isIdle?.() !== false) return true;
			await new Promise((r) => setTimeout(r, 100));
		}
		return false;
	};

	// ========================================================================
	// Session lifecycle
	// ========================================================================

	pi.on("session_start", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		// OMP re-imports this extension for every task subagent, so each child
		// session runs its OWN copy (verified: same pid, fresh module instance
		// per child). Without a gate every subagent would checkpoint its whole
		// run into the shadow store under a session namespace no tree UI can
		// ever reach — pure pollution plus ~100ms per mutating child tool.
		//
		// Discriminator: a process-global claim. The main session's instance
		// always loads first (children can only be spawned from inside a main
		// turn); an interactive instance (hasUI) may also take over the claim
		// (e.g. /reload creating a fresh instance). Everyone else goes inert.
		const registry = globalThis as Record<PropertyKey, unknown>;
		const CLAIM = Symbol.for("omp-rewind.main-claim");
		if (registry[CLAIM] === undefined || ctx.hasUI) {
			registry[CLAIM] = state;
		}
		if (registry[CLAIM] !== state) {
			state.shadow = null;
			return;
		}
		state.sawTask = false;
		state.pending = null;
		state.busy = false;
		state.sessionId = sid;
		const root = await git(["rev-parse", "--show-toplevel"], ctx.cwd).catch(
			() => "",
		);
		if (root.length === 0) {
			state.shadow = null;
			if (ctx.hasUI) {
				ctx.ui.notify(
					"omp-rewind disabled: not a git repository. File restore on tree navigation is unavailable.",
					"info",
				);
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
			return;
		}
		state.shadow = await openShadow(root, state.sessionId);
		await updateStatus(ctx);
	});

	// ========================================================================
	// Checkpoint schedule
	// ========================================================================

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state.shadow || state.busy) return;
		if (ctx.sessionManager.getSessionId() !== state.sessionId) return;
		await scheduleCheckpoint(ctx, currentLeafEntry(ctx), "turn-start");
	});

	pi.on(
		"tool_execution_end",
		async (event: { toolName?: string }, ctx: ExtensionContextLike) => {
			if (!state.shadow || state.busy) return;
			if (ctx.sessionManager.getSessionId() !== state.sessionId) return;
			const toolName = event.toolName ?? "";
			if (toolName === "task") state.sawTask = true;
			if (state.granularity === "turn") return;
			if (READ_ONLY_TOOLS[toolName]) return;
			const entryId = ctx.sessionManager.getEntries().at(-1)?.id;
			if (!entryId) return;
			await scheduleCheckpoint(ctx, entryId, `after-${toolName}`);
		},
	);

	// ========================================================================
	// Tree navigation: decide in session_before_tree, apply in session_tree
	// ========================================================================

	pi.on(
		"session_before_tree",
		async (
			event: TreePreparationLike,
			ctx: ExtensionContextLike,
		): Promise<BeforeTreeResult | undefined> => {
			state.pending = null;
			const shadow = state.shadow;
			if (!shadow || !ctx.hasUI) return undefined;

			const targetId = event.targetId ?? event.preparation?.targetId;
			if (ctx.sessionManager.getSessionId() !== state.sessionId) {
				return undefined;
			}
			const oldLeafId =
				event.oldLeafId !== undefined
					? event.oldLeafId
					: (event.preparation?.oldLeafId ?? null);
			const signal = event.signal ?? event.preparation?.signal;
			if (!targetId) return undefined;

			if (!(await waitForIdle(ctx))) {
				ctx.ui.notify(
					"omp-rewind: agent did not stop in time; navigation cancelled.",
					"warning",
				);
				return { cancel: true };
			}

			// Preserve the leaving state so navigating back restores it.
			await scheduleCheckpoint(ctx, oldLeafId ?? ROOT_ENTRY, "leaving");

			const newLeaf = effectiveNewLeaf(ctx, targetId);
			const found = await findRestorePoint(shadow, ctx, newLeaf);
			if (signal?.aborted) return { cancel: true };

			if (!found) {
				const choice = await ctx.ui.select(
					"No file checkpoint covers this point. Conversation will be restored; files stay as they are.",
					["Restore conversation only", "Cancel"],
				);
				if (choice !== "Restore conversation only") return { cancel: true };
				state.pending = { mode: "conversation", checkpoint: null };
				return undefined;
			}

			const { checkpoint, exact } = found;
			const leaving = await loadCheckpoint(
				shadow,
				state.sessionId,
				oldLeafId ?? ROOT_ENTRY,
			);
			const stat =
				leaving === null
					? ""
					: await diffTreeStat(
							shadow,
							leaving.worktreeTreeSha,
							checkpoint.worktreeTreeSha,
						);

			const lines: string[] = [];
			if (!exact) {
				lines.push(
					`Nearest file checkpoint is an ancestor (${checkpoint.label ?? checkpoint.entryId}, ${checkpoint.createdAt}).`,
				);
			}
			if (stat === "") {
				lines.push("Files are unchanged between here and the checkpoint.");
			} else {
				const statLines = stat.split("\n");
				lines.push(
					"File changes to be reverted:",
					...statLines.slice(0, 12),
					...(statLines.length > 12
						? [`… ${statLines.length - 12} more lines`]
						: []),
				);
			}
			if (state.sawTask) {
				lines.push(
					"⚠ This session spawned subagents. A background subagent that is still running keeps writing files after the restore — cancel it first (job cancel / Agent Hub).",
				);
			}

			const choice = await ctx.ui.select(lines.join("\n"), [
				"Restore conversation + files",
				"Restore conversation only",
				"Cancel",
			]);
			if (signal?.aborted || choice === undefined || choice === "Cancel") {
				return { cancel: true };
			}

			state.pending = {
				mode: choice === "Restore conversation + files" ? "all" : "conversation",
				checkpoint,
			};
			return undefined;
		},
	);

	pi.on(
		"session_tree",
		async (
			event: { newLeafId?: string | null },
			ctx: ExtensionContextLike,
		) => {
			if (ctx.sessionManager.getSessionId() !== state.sessionId) return;
			const pending = state.pending;
			state.pending = null;
			const shadow = state.shadow;
			if (!shadow || !pending) return;
			if (pending.mode !== "all" || !pending.checkpoint) return;

			state.busy = true;
			try {
				await state.writing;
				// Re-resolve from the authoritative new leaf; falls back to the
				// decision-time checkpoint if resolution disagrees.
				const found = await findRestorePoint(
					shadow,
					ctx,
					event.newLeafId ?? null,
				);
				const result = await restoreCheckpoint(
					shadow,
					found?.checkpoint ?? pending.checkpoint,
				);
				if (ctx.hasUI) {
					ctx.ui.notify(
						result.stagedRestored
							? "Files restored to checkpoint."
							: "Files restored; staged/unstaged split could not be reproduced (HEAD moved), all changes are unstaged.",
						"info",
					);
				}
			} catch (error) {
				const message =
					error instanceof RestoreBlockedError
						? error.message
						: `File restore failed: ${error instanceof Error ? error.message : String(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
			} finally {
				state.busy = false;
			}
			await updateStatus(ctx);
		},
	);

	// ========================================================================
	// Manual pruning (refs are never deleted automatically)
	// ========================================================================

	pi.registerCommand("rewind-prune", {
		description:
			"Delete omp-rewind checkpoint refs from the shadow store. Default: other sessions only; 'all' wipes every session and packs the store.",
		handler: async (args, ctx) => {
			const shadow = state.shadow;
			if (!shadow) {
				if (ctx.hasUI) ctx.ui.notify("omp-rewind is disabled here.", "warning");
				return;
			}
			const scope = args.trim() === "all" ? "all" : "others";
			const deleted = await pruneCheckpoints(shadow, scope, state.sessionId);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Pruned ${deleted} checkpoint ref${deleted === 1 ? "" : "s"} (${scope}).`,
					"info",
				);
			}
			await updateStatus(ctx);
		},
	});
}
