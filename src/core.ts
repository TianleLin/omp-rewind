/**
 * omp-rewind — pure git core. Zero OMP dependency; independently testable.
 *
 * Architecture: a SHADOW repository (bare git dir under the extension cache)
 * whose --work-tree points at the user's workspace. All checkpoint objects
 * and refs live in the shadow; the workspace's own .git is NEVER written to
 * by checkpointing (no refs, no objects, no reflog — nothing for
 * `push --mirror`, GUIs, or backups to pick up).
 *
 * Checkpoint = full workspace snapshot (tracked + non-ignored untracked,
 * plus the staged diff as a patch blob) stored as a commit at
 * `refs/omp-rewind/<session>/<entry>` in the shadow. Restore never moves
 * HEAD or the branch pointer; it rewrites worktree files and — as the one
 * intentional workspace-index write — reproduces the staged/unstaged split.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const REF_BASE = "refs/omp-rewind";
export const ZEROS = "0".repeat(40);

/**
 * Tools that never mutate the workspace. Anything NOT listed causes a
 * checkpoint (unknown tools are treated as mutating; identical-tree
 * checkpoints are cheap thanks to the persistent shadow index).
 */
export const READ_ONLY_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	find: true,
	ls: true,
	ast_grep: true,
	web_search: true,
	web_fetch: true,
	ask: true,
	todo: true,
	task_status: true,
};

export interface CheckpointMeta {
	/** Raw session entry ID this snapshot is bound to ("root" for empty tree). */
	entryId: string;
	sessionId: string;
	/** Workspace branch at snapshot time (restore is blocked cross-branch). */
	branch: string;
	headSha: string;
	worktreeTreeSha: string;
	/** Shadow blob holding `diff --cached --binary` at snapshot time. */
	stagedPatchBlob: string | null;
	createdAt: string;
	label?: string;
}

export interface GitRunOptions {
	env?: Record<string, string | undefined>;
	input?: string;
	/** Return stdout verbatim (default strips one trailing newline). */
	raw?: boolean;
}

/** Run git with an args array (no shell, no quoting pitfalls). */
export function git(
	args: string[],
	cwd: string,
	opts: GitRunOptions = {},
): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const proc = spawn("git", args, {
		cwd,
		env: opts.env ? { ...process.env, ...opts.env } : process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	proc.stdout.on("data", (d: Buffer) => {
		stdout += d;
	});
	proc.stderr.on("data", (d: Buffer) => {
		stderr += d;
	});
	proc.on("error", reject);
	proc.on("close", (code) => {
		if (code === 0) {
			resolve(opts.raw ? stdout : stdout.replace(/\n$/, ""));
		} else {
			reject(new Error(stderr.trim() || `git ${args[0]} failed (code ${code})`));
		}
	});

	if (opts.input !== undefined) {
		proc.stdin.write(opts.input);
	}
	proc.stdin.end();
	return promise;
}

/** Sanitize an ID for use as a git ref path component. */
export function refComponent(id: string): string {
	const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_");
	// git refs may not start with "." or end with ".lock"
	const safe = cleaned.replace(/^\.+/, "_").replace(/\.lock$/i, "_lock");
	return safe.length > 0 ? safe : "_";
}

export function checkpointRef(sessionId: string, entryId: string): string {
	return `${REF_BASE}/${refComponent(sessionId)}/${refComponent(entryId)}`;
}

// ============================================================================
// Shadow repository
// ============================================================================

export interface ShadowRepo {
	/** Bare git dir under the extension cache (all writes land here). */
	gitDir: string;
	/** The user's workspace root (files only; its .git is never written). */
	workTree: string;
	/** Per-session persistent index (incremental `add -A` across checkpoints). */
	indexFile: string;
}

/**
 * Open (or initialize) the shadow repository for a workspace. One shadow
 * per workspace root — object store is shared across sessions for dedup;
 * the index file is per-session to avoid concurrent-session races.
 */
export async function openShadow(
	workTree: string,
	sessionId: string,
	cacheRoot: string = join(homedir(), ".omp", "agent", "cache", "omp-rewind"),
): Promise<ShadowRepo> {
	const key = createHash("sha256").update(workTree).digest("hex").slice(0, 16);
	const gitDir = join(cacheRoot, key);
	try {
		await access(join(gitDir, "HEAD"));
	} catch {
		await mkdir(gitDir, { recursive: true });
		await git(["init", "--bare", "--quiet", gitDir], cacheRoot);
		await git(["config", "gc.auto", "0"], gitDir);
	}
	return {
		gitDir,
		workTree,
		indexFile: join(gitDir, `index-${refComponent(sessionId)}`),
	};
}

/** Run git against the shadow object store with the workspace as work-tree. */
function shadowGit(
	shadow: ShadowRepo,
	args: string[],
	opts: GitRunOptions = {},
): Promise<string> {
	return git(
		["--git-dir", shadow.gitDir, "--work-tree", shadow.workTree, ...args],
		shadow.workTree,
		{
			...opts,
			env: { ...opts.env, GIT_INDEX_FILE: shadow.indexFile },
		},
	);
}

/**
 * Sync the shadow index to the current workspace state and return the tree.
 * `add -A` respects the workspace's .gitignore; a second force-add keeps
 * files that the real repo tracks even when ignore rules match them.
 */
export async function syncShadowIndex(shadow: ShadowRepo): Promise<string> {
	await shadowGit(shadow, ["add", "-A", "."]);
	const tracked = await git(["ls-files", "-z"], shadow.workTree, {
		raw: true,
	}).catch(() => "");
	if (tracked.length > 0) {
		await shadowGit(
			shadow,
			["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"],
			{ input: tracked },
		);
	}
	return shadowGit(shadow, ["write-tree"]);
}

// ============================================================================
// Checkpoint CRUD
// ============================================================================

interface RepoHead {
	branch: string;
	headSha: string;
}

/** Branch name + HEAD sha of the REAL repo (read-only). */
async function readHead(root: string): Promise<RepoHead> {
	const headSha = await git(["rev-parse", "HEAD"], root).catch(() => ZEROS);
	const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], root).catch(
		() => "unborn",
	);
	return { branch, headSha };
}

export interface CreateCheckpointOpts {
	shadow: ShadowRepo;
	sessionId: string;
	entryId: string;
	label?: string;
}

/**
 * Snapshot the full workspace into a shadow ref bound to a session entry.
 * The workspace repo is only READ (HEAD, branch, staged diff, tracked list);
 * every write goes to the shadow.
 */
export async function createCheckpoint(
	opts: CreateCheckpointOpts,
): Promise<CheckpointMeta> {
	const { shadow, sessionId, entryId, label } = opts;
	const root = shadow.workTree;
	const createdAt = new Date().toISOString();
	const { branch, headSha } = await readHead(root);

	const stagedPatch = await git(
		["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"],
		root,
		{ raw: true },
	).catch(() => "");
	const stagedPatchBlob =
		stagedPatch.trim().length === 0
			? null
			: await shadowGit(shadow, ["hash-object", "-w", "--stdin"], {
					input: stagedPatch,
				});

	const worktreeTreeSha = await syncShadowIndex(shadow);

	const meta: CheckpointMeta = {
		entryId,
		sessionId,
		branch,
		headSha,
		worktreeTreeSha,
		stagedPatchBlob,
		createdAt,
		label,
	};

	const commitSha = await shadowGit(shadow, ["commit-tree", worktreeTreeSha], {
		input: `omp-rewind checkpoint\n\n${JSON.stringify(meta)}\n`,
		env: {
			GIT_AUTHOR_NAME: "omp-rewind",
			GIT_AUTHOR_EMAIL: "rewind@omp",
			GIT_COMMITTER_NAME: "omp-rewind",
			GIT_COMMITTER_EMAIL: "rewind@omp",
			GIT_AUTHOR_DATE: createdAt,
			GIT_COMMITTER_DATE: createdAt,
		},
	});
	await shadowGit(shadow, [
		"update-ref",
		checkpointRef(sessionId, entryId),
		commitSha,
	]);
	return meta;
}

/** Load checkpoint metadata for a session entry; null when absent/corrupt. */
export async function loadCheckpoint(
	shadow: ShadowRepo,
	sessionId: string,
	entryId: string,
): Promise<CheckpointMeta | null> {
	try {
		const ref = checkpointRef(sessionId, entryId);
		const commitSha = await shadowGit(shadow, ["rev-parse", "--verify", ref]);
		const raw = await shadowGit(shadow, ["cat-file", "commit", commitSha]);
		const bodyStart = raw.indexOf("\n\n");
		if (bodyStart === -1) return null;
		const jsonStart = raw.indexOf("{", bodyStart);
		if (jsonStart === -1) return null;
		const meta = JSON.parse(raw.slice(jsonStart)) as CheckpointMeta;
		if (!meta.worktreeTreeSha) return null;
		return meta;
	} catch {
		return null;
	}
}

// ============================================================================
// Restore
// ============================================================================

export type RestoreBlockReason = "branch-mismatch" | "detached-head-moved";

export class RestoreBlockedError extends Error {
	constructor(
		public readonly reason: RestoreBlockReason,
		message: string,
	) {
		super(message);
		this.name = "RestoreBlockedError";
	}
}

export interface RestoreResult {
	/**
	 * False when the staged/unstaged split could not be reproduced (HEAD
	 * moved since the checkpoint, so the staged patch no longer applies);
	 * files are still restored, everything shows as unstaged changes.
	 */
	stagedRestored: boolean;
}

/**
 * Restore worktree files + the workspace index split to a checkpoint.
 * HEAD and the branch pointer are never modified; commits made after the
 * checkpoint stay reachable. Cross-branch restores are blocked.
 *
 * Ignored-but-untracked files never enter the shadow index, so they are
 * invisible here and never deleted.
 */
export async function restoreCheckpoint(
	shadow: ShadowRepo,
	cp: CheckpointMeta,
): Promise<RestoreResult> {
	const root = shadow.workTree;
	const { branch, headSha } = await readHead(root);
	if (branch !== cp.branch) {
		throw new RestoreBlockedError(
			"branch-mismatch",
			`Checkpoint was taken on "${cp.branch}" but you are on "${branch}". Switch back to "${cp.branch}" to restore files.`,
		);
	}
	if (branch === "HEAD" && headSha !== cp.headSha) {
		throw new RestoreBlockedError(
			"detached-head-moved",
			"Checkpoint was taken on a detached HEAD that has since moved; file restore would be ambiguous.",
		);
	}

	// 1. Shadow index := current disk state, then worktree := snapshot tree.
	//    read-tree --reset -u adds, rewrites, and deletes files as needed
	//    (files created after the checkpoint are in the synced index but not
	//    in the target tree, so -u removes them).
	await syncShadowIndex(shadow);
	await shadowGit(shadow, ["read-tree", "--reset", "-u", cp.worktreeTreeSha]);

	// 2. Workspace index := HEAD, then replay the staged diff. This is the
	//    single intentional write to the workspace repo — it IS the restore
	//    of the staged/unstaged split the user had.
	if (headSha === ZEROS) {
		await git(["read-tree", "--empty"], root);
	} else {
		await git(["read-tree", "HEAD"], root);
	}
	let stagedRestored = true;
	if (cp.stagedPatchBlob) {
		const patch = await shadowGit(
			shadow,
			["cat-file", "blob", cp.stagedPatchBlob],
			{ raw: true },
		);
		try {
			await git(["apply", "--cached", "--whitespace=nowarn", "-"], root, {
				input: patch,
			});
		} catch {
			stagedRestored = false;
		}
	}
	return { stagedRestored };
}

// ============================================================================
// Ref listing / pruning / diff
// ============================================================================

export interface RefListing {
	sessionComponent: string;
	entryComponent: string;
	ref: string;
}

export async function listCheckpointRefs(
	shadow: ShadowRepo,
): Promise<RefListing[]> {
	const out = await shadowGit(shadow, [
		"for-each-ref",
		"--format=%(refname)",
		`${REF_BASE}/`,
	]).catch(() => "");
	const listings: RefListing[] = [];
	for (const ref of out.split("\n")) {
		if (!ref.startsWith(`${REF_BASE}/`)) continue;
		const rest = ref.slice(REF_BASE.length + 1);
		const slash = rest.indexOf("/");
		if (slash === -1) continue;
		listings.push({
			sessionComponent: rest.slice(0, slash),
			entryComponent: rest.slice(slash + 1),
			ref,
		});
	}
	return listings;
}

/**
 * Delete checkpoint refs. `scope: "others"` keeps the given session,
 * `scope: "all"` wipes everything and garbage-collects the shadow.
 * Returns number of refs deleted.
 */
export async function pruneCheckpoints(
	shadow: ShadowRepo,
	scope: "others" | "all",
	currentSessionId: string,
): Promise<number> {
	const keep = refComponent(currentSessionId);
	const listings = await listCheckpointRefs(shadow);
	let deleted = 0;
	for (const { sessionComponent, ref } of listings) {
		if (scope === "others" && sessionComponent === keep) continue;
		await shadowGit(shadow, ["update-ref", "-d", ref]).catch(() => {});
		deleted++;
	}
	if (scope === "all") {
		await shadowGit(shadow, ["gc", "--prune=now", "--quiet"]).catch(() => {});
	}
	return deleted;
}

/** Count checkpoints belonging to a session (for the status footer). */
export async function countSessionCheckpoints(
	shadow: ShadowRepo,
	sessionId: string,
): Promise<number> {
	const wanted = refComponent(sessionId);
	const listings = await listCheckpointRefs(shadow);
	let count = 0;
	for (const { sessionComponent } of listings) {
		if (sessionComponent === wanted) count++;
	}
	return count;
}

/** One-line stat summary between two trees ("" when identical). */
export async function diffTreeStat(
	shadow: ShadowRepo,
	fromTree: string,
	toTree: string,
): Promise<string> {
	if (fromTree === toTree) return "";
	return shadowGit(shadow, [
		"diff-tree",
		"--stat",
		"--no-commit-id",
		fromTree,
		toTree,
	]).catch(() => "");
}
