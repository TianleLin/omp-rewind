/**
 * omp-rewind — OMP extension entry point.
 *
 * Binds git workspace checkpoints to session-tree entry IDs so OMP's native
 * double-Esc tree navigation restores conversation and files together.
 *
 * All checkpoint data lives in a SHADOW git dir under the extension cache;
 * the workspace's own .git is never polluted (no refs, no objects). A git
 * repository is NOT required: plain folders run in folder mode (snapshots +
 * restores, no staged-split/branch semantics). Only a missing git binary
 * disables the extension.
 *
 * MULTI-PROCESS: a second omp on the same workspace is detected via
 * presence files in the shadow (see presence.ts). Restoring files while a
 * peer's agent is mid-turn is blocked by default with a force escape hatch
 * — nothing can actually stop the other process, so the user must.
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

import { realpath } from "node:fs/promises";
import {
	type CheckpointMeta,
	countSessionCheckpoints,
	createCheckpoint,
	diffTreeStat,
	git,
	listCheckpointRefs,
	listGitlinks,
	listTreeGitlinks,
	loadCheckpoint,
	openShadow,
	pruneCheckpoints,
	type PruneScope,
	READ_ONLY_TOOLS,
	refComponent,
	RestoreBlockedError,
	restoreCheckpoint,
	type ShadowRepo,
} from "./core.ts";
import { clearPresence, listPeers, writePresence } from "./presence.ts";
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

/** "just now" / "37s ago" / "5m ago" for presence dialog lines. */
function formatAge(ms: number): string {
	if (ms < 5_000) return "just now";
	if (ms < 120_000) return `${Math.round(ms / 1000)}s ago`;
	return `${Math.round(ms / 60_000)}m ago`;
}

interface PendingRestore {
	mode: "all" | "conversation";
	checkpoint: CheckpointMeta | null;
	/** Files option was gated out — tell the user WHY files stayed put. */
	filesSkippedReason?: string;
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
	/** Last checkpoint attempt failed — surfaced in the status bar. */
	checkpointFailing: boolean;
	/** Folder mode: gitlink paths found in the shadow index (blocks file restore). */
	nestedRepos: string[];
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
		checkpointFailing: false,
		nestedRepos: [],
	};

	const updateStatus = async (ctx: ExtensionContextLike): Promise<void> => {
		if (!ctx.hasUI) return;
		if (!state.shadow) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const count = await countSessionCheckpoints(state.shadow, state.sessionId);
		const nestedMark =
			state.shadow.noRepo && state.nestedRepos.length > 0
				? " (folder ⚠ nested repos)"
				: state.shadow.noRepo
					? " (folder)"
					: "";
		const suffix = nestedMark;
		const health = state.checkpointFailing ? " ⚠ failing" : "";
		ctx.ui.setStatus(
			STATUS_KEY,
			`◆ ${count} checkpoint${count === 1 ? "" : "s"}${suffix}${health}`,
		);
	};

	/**
	 * Queue a checkpoint write; failures never throw, but they are VISIBLE:
	 * first failure notifies, and the status bar shows "⚠ failing" until a
	 * checkpoint succeeds again (a silent 0 cost a real user their restores).
	 */
	const scheduleCheckpoint = (
		ctx: ExtensionContextLike,
		entryId: string,
		label: string,
	): Promise<void> => {
		const shadow = state.shadow;
		if (!shadow) return Promise.resolve();
		// Capture NOW, not at execution: a pending write may straddle a /new
		// rebind, and executing with the swapped state.sessionId would file the
		// old session's snapshot under the new session's namespace (garbage
		// ref bound to an entry id the new tree can never resolve).
		const sessionId = state.sessionId;
		const run = state.writing.then(async () => {
			try {
				await createCheckpoint({
					shadow,
					sessionId,
					entryId,
					label,
				});
				state.checkpointFailing = false;
				// Folder mode: refresh the nested-repo set (gitlinks make file
				// restore silently partial — the dialog blocks it while present).
				state.nestedRepos = shadow.noRepo ? await listGitlinks(shadow) : [];
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				pi.logger?.warn?.(`omp-rewind: checkpoint failed: ${message}`);
				if (!state.checkpointFailing && ctx.hasUI) {
					ctx.ui.notify(
						`omp-rewind: checkpoints are failing — file restore will not cover new changes. First error: ${message}`,
						"warning",
					);
				}
				state.checkpointFailing = true;
			}
		});
		state.writing = run;
		return run.then(() => updateStatus(ctx));
	};

	/**
	 * Tree position of "before this turn": the just-persisted user/custom
	 * message moves the restore target to its PARENT (mirrors OMP's
	 * navigateTree rule and our effectiveNewLeaf). Binding the turn-start
	 * checkpoint to the user entry itself would make it unreachable — the
	 * ancestor chain of parent(user) never contains the user entry.
	 */
	const preTurnAnchor = (ctx: ExtensionContextLike): string => {
		const leaf = ctx.sessionManager.getBranch().at(-1);
		if (!leaf) return ROOT_ENTRY;
		return isUserish(leaf) ? (leaf.parentId ?? ROOT_ENTRY) : leaf.id;
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
		const gitOk = await git(["--version"], ctx.cwd).then(
			() => true,
			() => false,
		);
		if (!gitOk) {
			state.shadow = null;
			if (ctx.hasUI) {
				ctx.ui.notify(
					"omp-rewind disabled: git is not installed (or not on PATH). Install git to enable checkpoints and file restore.",
					"warning",
				);
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
			return;
		}
		let root = await git(["rev-parse", "--show-toplevel"], ctx.cwd).catch(
			() => "",
		);
		const noRepo = root.length === 0;
		if (noRepo) {
			// Normalize symlinked cwds so every entry path hashes to the same
			// shadow (git already returns the physical path in repo mode).
			root = await realpath(ctx.cwd).catch(() => ctx.cwd);
		}
		state.shadow = await openShadow(root, state.sessionId, { noRepo });
		await writePresence(state.shadow.gitDir, state.sessionId, false);
		await updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (state.shadow) await clearPresence(state.shadow.gitDir);
	});

	// /clear, /resume-switch and friends replace the live session without a
	// session_start; the lazy rebind in before_agent_start only fires at the
	// NEXT turn, so the status bar kept showing the OLD session's checkpoint
	// count until then. Rebind eagerly on every session-swap event OMP emits.
	for (const swapEvent of ["session_switch", "session_branch"]) {
		pi.on(swapEvent, async (_event, ctx: ExtensionContextLike) => {
			await rebindIfSessionChanged(ctx);
		});
	}

	// ========================================================================
	// Cross-process presence: advertise busy/idle so a second omp on this
	// workspace can refuse to restore files while our agent is mid-turn.
	// ========================================================================

	pi.on("agent_start", async (_event, ctx: ExtensionContextLike) => {
		if (!state.shadow) return;
		if (ctx.sessionManager.getSessionId() !== state.sessionId) return;
		await writePresence(state.shadow.gitDir, state.sessionId, true);
	});

	pi.on("agent_end", async (_event, ctx: ExtensionContextLike) => {
		if (!state.shadow) return;
		if (ctx.sessionManager.getSessionId() !== state.sessionId) return;
		await writePresence(state.shadow.gitDir, state.sessionId, false);
	});

	// ========================================================================
	// Checkpoint schedule
	// ========================================================================

	/**
	 * /new, /resume and RPC new_session/switch_session replace the live
	 * session WITHOUT re-firing session_start (probed empirically: after
	 * new_session the second session got zero refs — every handler
	 * early-returned on the stale sessionId, silently and forever). The
	 * interactive instance (hasUI) rebinds lazily on the next turn/navigation:
	 * same workspace, same shadow store, fresh per-session index + presence.
	 */
	const rebindIfSessionChanged = async (
		ctx: ExtensionContextLike,
	): Promise<void> => {
		if (!ctx.hasUI || !state.shadow) return;
		const sid = ctx.sessionManager.getSessionId();
		if (sid === state.sessionId) return;
		state.sessionId = sid;
		state.sawTask = false;
		state.pending = null;
		state.busy = false;
		state.checkpointFailing = false;
		state.shadow = await openShadow(state.shadow.workTree, sid, {
			noRepo: state.shadow.noRepo,
		});
		await writePresence(state.shadow.gitDir, sid, false);
		await updateStatus(ctx);
	};

	pi.on("before_agent_start", async (_event, ctx) => {
		await rebindIfSessionChanged(ctx);
		if (!state.shadow || state.busy) return;
		if (ctx.sessionManager.getSessionId() !== state.sessionId) return;
		await scheduleCheckpoint(ctx, preTurnAnchor(ctx), "turn-start");
	});

	pi.on(
		"tool_execution_end",
		async (event: { toolName?: string }, ctx: ExtensionContextLike) => {
			if (!state.shadow || state.busy) return;
			if (ctx.sessionManager.getSessionId() !== state.sessionId) return;
			// Cross-process liveness: any tool completion proves we're mid-turn.
			void writePresence(state.shadow.gitDir, state.sessionId, true);
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
			await rebindIfSessionChanged(ctx);
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

			const peers = await listPeers(shadow.gitDir);
			const busyPeers = peers.filter((peer) => peer.busy);
			for (const peer of busyPeers) {
				lines.push(
					`⛔ Another omp instance (pid ${peer.pid}, active ${formatAge(peer.ageMs)}) is running an agent in this workspace right now. It keeps writing files during a restore — stop it there (Esc) first, or force at your own risk.`,
				);
			}
			if (busyPeers.length === 0 && peers.length > 0) {
				lines.push(
					`ℹ ${peers.length === 1 ? "Another omp instance has" : `${peers.length} omp instances have`} this workspace open (currently idle).`,
				);
			}
			// Foreign gitlinks (embedded repos the real repo does not track as
			// submodules) make file restore silently partial — pre-block here
			// with the SAME set core's restoreCheckpoint guard uses: current
			// session index ∪ resolved target checkpoint tree, minus the real
			// repo's tracked 160000 entries. Without the target-tree union a
			// child that only exists in the checkpoint (since replaced by a
			// plain dir + fresh index) would still show the files option and
			// fail after navigation instead of before it.
			const nestedSet = new Set<string>([
				...(await listGitlinks(shadow)),
				...(await listTreeGitlinks(shadow, checkpoint.worktreeTreeSha)),
			]);
			if (!shadow.noRepo && nestedSet.size > 0) {
				const raw = await git(["ls-files", "-sz"], shadow.workTree, {
					raw: true,
				}).catch(() => "");
				for (const entry of raw.split("\0")) {
					if (entry.startsWith("160000 ")) {
						const tab = entry.indexOf("\t");
						if (tab !== -1) nestedSet.delete(entry.slice(tab + 1));
					}
				}
			}
			const nested = [...nestedSet];
			if (nested.length > 0) {
				lines.push(
					`⛔ Nested git repositor${nested.length === 1 ? "y is" : "ies are"} not covered by these checkpoints (${nested.slice(0, 3).join(", ")}${nested.length > 3 ? ", …" : ""}) — file restore is disabled for this workspace. Run omp inside the nested repo for full-fidelity rewind there.`,
				);
			}


			const fileOption =
				busyPeers.length > 0
					? "Force restore files anyway (unsafe)"
					: "Restore conversation + files";
			const choice = await ctx.ui.select(
				lines.join("\n"),
				nested.length > 0
					? ["Restore conversation only", "Cancel"]
					: busyPeers.length > 0
						? ["Cancel", "Restore conversation only", fileOption]
						: [fileOption, "Restore conversation only", "Cancel"],
			);
			if (signal?.aborted || choice === undefined || choice === "Cancel") {
				return { cancel: true };
			}

			state.pending = {
				mode: choice === fileOption ? "all" : "conversation",
				checkpoint,
				filesSkippedReason:
					choice !== fileOption && nested.length > 0
						? "nested git repositories are present — file restore is disabled for this workspace"
						: undefined,
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
			if (pending.mode !== "all" || !pending.checkpoint) {
				// Conversation moved but files DID NOT — when that was forced by
				// a gate (not an explicit user choice), say so out loud: a
				// silent no-op here reads as "restore is broken".
				if (pending.filesSkippedReason && ctx.hasUI) {
					ctx.ui.notify(
						`Files were NOT restored: ${pending.filesSkippedReason}.`,
						"warning",
					);
				}
				return;
			}

			state.busy = true;
			await writePresence(shadow.gitDir, state.sessionId, true);
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
				await writePresence(shadow.gitDir, state.sessionId, false);
			}
			await updateStatus(ctx);
		},
	);

	// ========================================================================
	// Manual pruning (refs are never deleted automatically)
	// ========================================================================

	pi.registerCommand("rewind-prune", {
		description:
			"Delete omp-rewind checkpoint refs. No args: pick a scope interactively. Args: current | others | all | keep <N> (keep the N newest of this session).",
		handler: async (args, ctx) => {
			// A /new may have swapped the live session since the last turn;
			// the scope must resolve against the CURRENT session, not a stale one.
			await rebindIfSessionChanged(ctx);
			const shadow = state.shadow;
			if (!shadow) {
				if (ctx.hasUI) ctx.ui.notify("omp-rewind is disabled here.", "warning");
				return;
			}
			const arg = args.trim();
			const keepMatch = /^keep\s+(\d+)$/.exec(arg);
			let scope: PruneScope | null = keepMatch
				? { keep: Number.parseInt(keepMatch[1] ?? "0", 10) }
				: arg === "current" || arg === "session"
					? "current"
					: arg === "others"
						? "others"
						: arg === "all"
							? "all"
							: null;
			if (scope === null && arg !== "") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Unknown scope "${arg}". Usage: /rewind-prune [current|others|all|keep <N>] (no args: choose interactively).`,
						"warning",
					);
				}
				return;
			}
			if (scope === null) {
				// No args → interactive scope picker (mirrors /compact UX),
				// OUTSIDE the critical section: a user parked on the picker
				// must not silently suppress checkpoints.
				if (!ctx.hasUI) return;
				const session = refComponent(state.sessionId);
				const listings = await listCheckpointRefs(shadow);
				const mine = listings.filter(
					(listing) => listing.sessionComponent === session,
				).length;
				const optionCurrent = `This session (${mine})`;
				const optionOthers = `Other sessions (${listings.length - mine})`;
				const optionAll = `Everything (${listings.length}) + pack store`;
				const choice = await ctx.ui.select(
					"Prune which checkpoints? (tip: `/rewind-prune keep <N>` keeps only this session's N newest)",
					[
					optionCurrent,
					optionOthers,
					optionAll,
					"Cancel",
				]);
				if (choice === optionCurrent) scope = "current";
				else if (choice === optionOthers) scope = "others";
				else if (choice === optionAll) scope = "all";
				else return;
			}
			// Critical section (scope decided): stop NEW checkpoint schedules
			// (busy), drain queued ones (state.writing) — otherwise a pending
			// checkpoint lands AFTER the deletes and "resurrects" refs, or
			// races the index cleanup under `all`. pruneCheckpoints re-lists
			// refs inside, so counts are fresh post-drain.
			state.busy = true;
			try {
				await state.writing;
				// Cross-process, scope-aware refusal (presence = UX check, not a
				// lock — TOCTOU remains; structural safety comes from no-prune
				// gc + per-pid indexes):
				// - current: a peer that resumed the SAME session has pending
				//   checkpoints that re-create refs right after we delete them
				//   ("cleared" refs resurrect) — refuse on same-session peers.
				// - others: deletes OTHER sessions' history mid-flight — refuse
				//   on any other-session peer.
				// - all: both hazards — refuse on any peer.
				const peers = await listPeers(shadow.gitDir);
				// keep-N targets only the current session — same conflict class.
				const scopeName =
					typeof scope === "object" ? `keep ${scope.keep}` : scope;
				const currentish = scope === "current" || typeof scope === "object";
				const conflicts =
					scope === "all"
						? peers
						: currentish
							? peers.filter((peer) => peer.sessionId === state.sessionId)
							: peers.filter((peer) => peer.sessionId !== state.sessionId);
				if (conflicts.length > 0) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Refusing '${scopeName}': ${conflicts.length} live omp instance${conflicts.length === 1 ? "" : "s"} (pid ${conflicts.map((peer) => peer.pid).join(", ")}) ${currentish ? "has this same session resumed — its pending checkpoints would immediately re-create the refs" : scope === "others" ? "is working in the sessions you are about to delete" : "has this workspace open — pruning everything would race its in-flight checkpoints"}. Close ${conflicts.length === 1 ? "it" : "them"} first.`,
							"warning",
						);
					}
					return;
				}
				const result = await pruneCheckpoints(shadow, scope, state.sessionId);
				if (ctx.hasUI) {
					const problems: string[] = [];
					if (result.failed > 0) {
						problems.push(
							`${result.failed} ref${result.failed === 1 ? "" : "s"} could not be deleted`,
						);
					}
					if (!result.indexCleanupOk)
						problems.push(
							"index cleanup failed — gc skipped to avoid poisoning (retry /rewind-prune all)",
						);
					else if (!result.gcOk)
						problems.push("gc failed (objects not reclaimed)");
					ctx.ui.notify(
						`Pruned ${result.deleted} checkpoint ref${result.deleted === 1 ? "" : "s"} (${scopeName}). Refs only — object disk space is not reclaimed (no cross-process lock; see README).${problems.length > 0 ? ` ⚠ ${problems.join("; ")}.` : ""}`,
						problems.length > 0 ? "warning" : "info",
					);
				}
			} finally {
				state.busy = false;
			}
			await updateStatus(ctx);
		},
	});
}
