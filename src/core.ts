/**
 * omp-rewind — pure git core. Zero OMP dependency; independently testable.
 *
 * Checkpoint = full workspace snapshot (tracked + staged + non-ignored
 * untracked) stored as a commit object referenced from
 * `refs/omp-rewind/<session>/<entry>`. Restore never moves HEAD or the
 * branch pointer; it only rewrites worktree + index.
 */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REF_BASE = "refs/omp-rewind";
export const ZEROS = "0".repeat(40);

/**
 * Tools that never mutate the workspace. Anything NOT listed causes a
 * checkpoint (unknown tools are treated as mutating; identical-tree
 * checkpoints are skipped by the caller, so over-triggering is cheap).
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
	branch: string;
	headSha: string;
	indexTreeSha: string;
	worktreeTreeSha: string;
	/** Untracked (non-ignored) paths at snapshot time — protected on restore. */
	untracked: string[];
	createdAt: string;
	label?: string;
}

export interface GitRunOptions {
	env?: Record<string, string | undefined>;
	input?: string;
	/** Exit codes to tolerate (stdout still returned). */
	okCodes?: number[];
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
		if (code === 0 || (code !== null && opts.okCodes?.includes(code))) {
			resolve(stdout.replace(/\n$/, ""));
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

interface RepoHead {
	branch: string;
	headSha: string;
}

/** Branch name + HEAD sha; handles unborn branches and detached HEAD. */
async function readHead(root: string): Promise<RepoHead> {
	const headSha = await git(["rev-parse", "HEAD"], root).catch(() => ZEROS);
	const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], root).catch(
		() => "unborn",
	);
	return { branch, headSha };
}

async function listUntracked(root: string): Promise<string[]> {
	const out = await git(
		["ls-files", "--others", "--exclude-standard", "-z"],
		root,
	).catch(() => "");
	return out.split("\0").filter((p) => p.length > 0);
}

export interface CreateCheckpointOpts {
	root: string;
	sessionId: string;
	entryId: string;
	label?: string;
}

/**
 * Snapshot the full workspace into a checkpoint ref bound to a session entry.
 * Never touches the real index: uses a temporary GIT_INDEX_FILE seeded from
 * HEAD, then a single `git add -A` (respects .gitignore, no path lists).
 */
export async function createCheckpoint(
	opts: CreateCheckpointOpts,
): Promise<CheckpointMeta> {
	const { root, sessionId, entryId, label } = opts;
	const createdAt = new Date().toISOString();
	const { branch, headSha } = await readHead(root);
	const indexTreeSha = await git(["write-tree"], root);
	const untracked = await listUntracked(root);

	const tmpDir = await mkdtemp(join(tmpdir(), "omp-rewind-"));
	try {
		const env = { GIT_INDEX_FILE: join(tmpDir, "index") };
		if (headSha !== ZEROS) {
			await git(["read-tree", headSha], root, { env });
		}
		await git(["add", "-A", "."], root, { env });
		const worktreeTreeSha = await git(["write-tree"], root, { env });

		const meta: CheckpointMeta = {
			entryId,
			sessionId,
			branch,
			headSha,
			indexTreeSha,
			worktreeTreeSha,
			untracked,
			createdAt,
			label,
		};

		const message = `omp-rewind checkpoint\n\n${JSON.stringify(meta)}\n`;
		const commitEnv = {
			GIT_AUTHOR_NAME: "omp-rewind",
			GIT_AUTHOR_EMAIL: "rewind@omp",
			GIT_COMMITTER_NAME: "omp-rewind",
			GIT_COMMITTER_EMAIL: "rewind@omp",
			GIT_AUTHOR_DATE: createdAt,
			GIT_COMMITTER_DATE: createdAt,
		};
		const commitSha = await git(["commit-tree", worktreeTreeSha], root, {
			input: message,
			env: commitEnv,
		});
		await git(
			["update-ref", checkpointRef(sessionId, entryId), commitSha],
			root,
		);
		return meta;
	} finally {
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Load checkpoint metadata for a session entry; null when absent/corrupt. */
export async function loadCheckpoint(
	root: string,
	sessionId: string,
	entryId: string,
): Promise<CheckpointMeta | null> {
	try {
		const ref = checkpointRef(sessionId, entryId);
		const commitSha = await git(["rev-parse", "--verify", ref], root);
		const raw = await git(["cat-file", "commit", commitSha], root);
		const bodyStart = raw.indexOf("\n\n");
		if (bodyStart === -1) return null;
		const body = raw.slice(bodyStart + 2);
		const jsonStart = body.indexOf("{");
		if (jsonStart === -1) return null;
		const meta = JSON.parse(body.slice(jsonStart)) as CheckpointMeta;
		if (!meta.worktreeTreeSha || !meta.indexTreeSha) return null;
		return meta;
	} catch {
		return null;
	}
}

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

/**
 * Restore worktree + index to a checkpoint. HEAD and the branch pointer are
 * never modified; commits made after the checkpoint stay reachable.
 *
 * Cross-branch restores are blocked (RestoreBlockedError).
 */
export async function restoreCheckpoint(
	root: string,
	cp: CheckpointMeta,
): Promise<void> {
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

	// 1. Worktree + index := snapshot tree (adds, updates, and removes files).
	await git(["read-tree", "--reset", "-u", cp.worktreeTreeSha], root);

	// 2. Delete untracked files that did not exist at checkpoint time.
	//    (.gitignore'd files are invisible here and thus never deleted.)
	const preexisting = new Set(cp.untracked);
	const current = await listUntracked(root);
	for (const rel of current) {
		if (!preexisting.has(rel)) {
			await rm(join(root, rel), { force: true }).catch(() => {});
		}
	}

	// 3. Index := snapshot index tree, without touching files. Restores the
	//    staged/unstaged/untracked split exactly as it was.
	await git(["read-tree", "--reset", cp.indexTreeSha], root);
}

export interface RefListing {
	sessionComponent: string;
	entryComponent: string;
	ref: string;
}

export async function listCheckpointRefs(root: string): Promise<RefListing[]> {
	const out = await git(
		["for-each-ref", "--format=%(refname)", `${REF_BASE}/`],
		root,
	).catch(() => "");
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
 * `scope: "all"` wipes everything. Returns number deleted.
 */
export async function pruneCheckpoints(
	root: string,
	scope: "others" | "all",
	currentSessionId: string,
): Promise<number> {
	const keep = refComponent(currentSessionId);
	const listings = await listCheckpointRefs(root);
	let deleted = 0;
	for (const { sessionComponent, ref } of listings) {
		if (scope === "others" && sessionComponent === keep) continue;
		await git(["update-ref", "-d", ref], root).catch(() => {});
		deleted++;
	}
	return deleted;
}

/** Count checkpoints belonging to a session (for the status footer). */
export async function countSessionCheckpoints(
	root: string,
	sessionId: string,
): Promise<number> {
	const wanted = refComponent(sessionId);
	const listings = await listCheckpointRefs(root);
	let count = 0;
	for (const { sessionComponent } of listings) {
		if (sessionComponent === wanted) count++;
	}
	return count;
}

/** One-line stat summary between two trees ("" when identical). */
export async function diffTreeStat(
	root: string,
	fromTree: string,
	toTree: string,
): Promise<string> {
	if (fromTree === toTree) return "";
	return git(
		["diff-tree", "--stat", "--no-commit-id", fromTree, toTree],
		root,
	).catch(() => "");
}

/** Tree sha of the current workspace state (content-only comparison key). */
export async function currentWorktreeTree(root: string): Promise<string> {
	const tmpDir = await mkdtemp(join(tmpdir(), "omp-rewind-cmp-"));
	try {
		const env = { GIT_INDEX_FILE: join(tmpDir, "index") };
		const headSha = await git(["rev-parse", "HEAD"], root).catch(() => ZEROS);
		if (headSha !== ZEROS) {
			await git(["read-tree", headSha], root, { env });
		}
		await git(["add", "-A", "."], root, { env });
		return await git(["write-tree"], root, { env });
	} finally {
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}
