/**
 * omp-rewind — OMP extension entry point.
 *
 * Binds git workspace checkpoints to session-tree entry IDs so OMP's native
 * double-Esc tree navigation restores conversation and files together.
 *
 * Checkpoint schedule (granularity "tool", the default):
 *   - before each agent turn  → ref bound to the current leaf entry
 *   - after each mutating tool → ref bound to the just-persisted entry
 * `OMP_REWIND_GRANULARITY=turn` drops the per-tool refs.
 *
 * Restore semantics (the contract):
 *   - navigation target resolves to the nearest self-or-ancestor checkpoint
 *   - worktree + index only; HEAD and branch pointer are never moved
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
	pruneCheckpoints,
	READ_ONLY_TOOLS,
	refComponent,
	RestoreBlockedError,
	restoreCheckpoint,
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

type RestoreMode = "all" | "conversation" | "cancel";

interface PendingRestore {
	mode: RestoreMode;
	checkpoint: CheckpointMeta | null;
}

interface State {
	enabled: boolean;
	root: string;
	sessionId: string;
	granularity: "tool" | "turn";
	/** Decision taken in session_before_tree, executed in session_tree. */
	pending: PendingRestore | null;
	/** Serializes checkpoint creation; restore waits for it. */
	writing: Promise<void>;
	busy: boolean;
}

function isUserish(entry: SessionEntryLike | undefined): boolean {
	if (!entry) return false;
	if (entry.type === "custom_message") return true;
	const role = entry.role ?? entry.message?.role;
	return entry.type === "message" && role === "user";
}

/**
 * The leaf the session will have after navigating to `targetId`:
 * user/custom messages move the leaf to their parent, everything else
 * becomes the leaf itself (mirrors OMP's navigateTree rules).
 */
function effectiveNewLeaf(
	ctx: ExtensionContextLike,
	targetId: string,
): string | null {
	const entry = ctx.sessionManager.getEntry(targetId);
	if (!entry) return targetId;
	return isUserish(entry) ? entry.parentId : targetId;
}

export default function (pi: PiApiLike) {
	const state: State = {
		enabled: false,
		root: "",
		sessionId: "",
		granularity:
			process.env.OMP_REWIND_GRANULARITY === "turn" ? "turn" : "tool",
		pending: null,
		writing: Promise.resolve(),
		busy: false,
	};

	const updateStatus = async (ctx: ExtensionContextLike): Promise<void> => {
		if (!ctx.hasUI) return;
		if (!state.enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const count = await countSessionCheckpoints(state.root, state.sessionId);
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
		const run = state.writing.then(async () => {
			try {
				await createCheckpoint({
					root: state.root,
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
	 * Nearest self-or-ancestor entry of `leafId` that has a checkpoint.
	 * Returns the checkpoint plus whether it is exact (bound to leaf itself).
	 */
	const findRestorePoint = async (
		ctx: ExtensionContextLike,
		leafId: string | null,
	): Promise<{ checkpoint: CheckpointMeta; exact: boolean } | null> => {
		const session = refComponent(state.sessionId);
		const available = new Set<string>();
		for (const listing of await listCheckpointRefs(state.root)) {
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
			const checkpoint = await loadCheckpoint(
				state.root,
				state.sessionId,
				entryId,
			);
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
		state.pending = null;
		state.busy = false;
		state.sessionId = ctx.sessionManager.getSessionId();
		state.root = await git(["rev-parse", "--show-toplevel"], ctx.cwd).catch(
			() => "",
		);
		state.enabled = state.root.length > 0;
		if (!state.enabled) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"omp-rewind disabled: not a git repository. File restore on tree navigation is unavailable.",
					"info",
				);
			}
			return;
		}
		await updateStatus(ctx);
	});

	// ========================================================================
	// Checkpoint schedule
	// ========================================================================

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state.enabled || state.busy) return;
		await scheduleCheckpoint(ctx, currentLeafEntry(ctx), "turn-start");
	});

	pi.on(
		"tool_execution_end",
		async (event: { toolName?: string }, ctx: ExtensionContextLike) => {
			if (!state.enabled || state.busy) return;
			if (state.granularity === "turn") return;
			const toolName = event.toolName ?? "";
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
			if (!state.enabled || !ctx.hasUI) return undefined;

			const targetId = event.targetId ?? event.preparation?.targetId;
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
			const found = await findRestorePoint(ctx, newLeaf);
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
				state.root,
				state.sessionId,
				oldLeafId ?? ROOT_ENTRY,
			);
			const stat =
				leaving === null
					? ""
					: await diffTreeStat(
							state.root,
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
			const pending = state.pending;
			state.pending = null;
			if (!state.enabled || !pending) return;
			if (pending.mode !== "all" || !pending.checkpoint) return;

			state.busy = true;
			try {
				await state.writing;
				// Re-resolve from the authoritative new leaf; falls back to the
				// decision-time checkpoint if resolution disagrees.
				const found = await findRestorePoint(ctx, event.newLeafId ?? null);
				await restoreCheckpoint(
					state.root,
					found?.checkpoint ?? pending.checkpoint,
				);
				if (ctx.hasUI) {
					ctx.ui.notify("Files restored to checkpoint.", "info");
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
			"Delete omp-rewind checkpoint refs. Default: other sessions only; 'all' wipes every session including this one.",
		handler: async (args, ctx) => {
			if (!state.enabled) {
				if (ctx.hasUI) ctx.ui.notify("omp-rewind is disabled here.", "warning");
				return;
			}
			const scope = args.trim() === "all" ? "all" : "others";
			const deleted = await pruneCheckpoints(
				state.root,
				scope,
				state.sessionId,
			);
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
