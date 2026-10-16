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
 *
 * FOLDER MODE: when the workspace is not a git repository, the same shadow
 * machinery still snapshots and restores files. The staged split and branch
 * guard degrade away (there is no workspace repo to read or write), and a
 * default exclude list stands in for .gitignore.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	lstat,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const REF_BASE = "refs/omp-rewind";
export const ZEROS = "0".repeat(40);
/** Sentinel branch recorded for folder-mode checkpoints (no workspace repo). */
export const NO_REPO_BRANCH = "(no-repo)";

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

/**
 * Run git with an args array (no shell, no quoting pitfalls).
 *
 * Boundary contracts (each broke in the wild before being pinned here):
 * - repo-targeting env vars inherited from the user's shell (GIT_DIR,
 *   GIT_INDEX_FILE, …) are STRIPPED — a stray `export GIT_INDEX_FILE` must
 *   not retarget checkpoint/restore plumbing. `opts.env` still wins.
 * - stdout/stderr are accumulated as Buffers and decoded ONCE: per-chunk
 *   `+=` decoding corrupts multibyte UTF-8 split across 64 KiB pipe chunks
 *   (staged patches with non-ASCII content came back as U+FFFD soup).
 * - stdin errors are swallowed: git may exit before draining its stdin
 *   (e.g. `apply` rejecting a patch early), and the resulting EPIPE must
 *   surface as the command's close/stderr, not as an uncaught stream error.
 */
export function git(
	args: string[],
	cwd: string,
	opts: GitRunOptions = {},
): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_NAMESPACE;
	delete env.GIT_OBJECT_DIRECTORY;
	delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	const proc = spawn("git", args, {
		cwd,
		env: opts.env ? { ...env, ...opts.env } : env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	proc.stdout.on("data", (d: Buffer) => {
		stdout.push(d);
	});
	proc.stderr.on("data", (d: Buffer) => {
		stderr.push(d);
	});
	proc.on("error", reject);
	proc.on("close", (code) => {
		if (code === 0) {
			const out = Buffer.concat(stdout).toString("utf-8");
			resolve(opts.raw ? out : out.replace(/\n$/, ""));
		} else {
			const err = Buffer.concat(stderr).toString("utf-8").trim();
			reject(new Error(err || `git ${args[0]} failed (code ${code})`));
		}
	});

	proc.stdin.on("error", () => {
		// EPIPE when git exits without reading stdin — reported via close.
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
	// git refs may not start or end with ".", nor end with ".lock"
	const safe = cleaned
		.replace(/^\.+/, "_")
		.replace(/\.+$/, "_")
		.replace(/\.lock$/i, "_lock");
	return safe.length > 0 ? safe : "_";
}

export function checkpointRef(sessionId: string, entryId: string): string {
	return `${REF_BASE}/${refComponent(sessionId)}/${refComponent(entryId)}`;
}

// ============================================================================
// Shadow repository
// ============================================================================

/**
 * Folder mode has no .gitignore contract, so these keep node_modules-scale
 * junk out of snapshots via the shadow's info/exclude (lowest precedence:
 * a real .gitignore in the work-tree still overrides them).
 */
export const FOLDER_MODE_EXCLUDES = [
	".git/",
	"node_modules/",
	"__pycache__/",
	".venv/",
	"venv/",
	"dist/",
	"build/",
	"out/",
	"target/",
	".next/",
	".nuxt/",
	".turbo/",
	".cache/",
	".direnv/",
	".DS_Store",
];

export interface ShadowRepo {
	/** Bare git dir under the extension cache (all writes land here). */
	gitDir: string;
	/** The user's workspace root (files only; its .git is never written). */
	workTree: string;
	/** Per-session persistent index (incremental `add -A` across checkpoints). */
	indexFile: string;
	/** Workspace is a plain folder, not a git repo (folder mode). */
	noRepo: boolean;
	/**
	 * Repo mode: path of the REAL repo's $GIT_DIR/info/exclude. The shadow
	 * runs `add -A` with ITS OWN GIT_DIR, so this file is invisible to it
	 * and must be mirrored into the shadow's info/exclude before every
	 * index sync — otherwise a file ignored only there enters the snapshot,
	 * and restoring an older checkpoint DELETES it from disk.
	 */
	realInfoExclude: string | null;
}

export interface OpenShadowOptions {
	cacheRoot?: string;
	/** The workspace is not a git repository — open in folder mode. */
	noRepo?: boolean;
}

/**
 * Mirror the one same-slot ignore source the shadow cannot see into the
 * shadow's info/exclude: folder mode → FOLDER_MODE_EXCLUDES; repo mode →
 * the REAL repo's info/exclude content (same precedence slot, so negation
 * semantics are preserved). core.excludesFile is NOT merged here — it
 * lives in a lower-precedence slot and is forwarded per-add via
 * `-c core.excludesFile=…` (see syncShadowIndex).
 */
export async function refreshShadowExcludes(shadow: ShadowRepo): Promise<void> {
	const content = shadow.noRepo
		? `${FOLDER_MODE_EXCLUDES.join("\n")}\n`
		: shadow.realInfoExclude
			? await readFile(shadow.realInfoExclude, "utf-8").catch(() => "")
			: "";
	await writeFile(join(shadow.gitDir, "info", "exclude"), content);
}

/**
 * Open (or initialize) the shadow repository for a workspace. One shadow
 * per workspace root — object store is shared across sessions for dedup;
 * the index file is per-session to avoid concurrent-session races.
 *
 * The shadow's info/exclude is rewritten on every open AND before every
 * index sync (see refreshShadowExcludes): folder mode seeds
 * FOLDER_MODE_EXCLUDES; repo mode mirrors the real repo's info/exclude +
 * resolved core.excludesFile (the two ignore sources a shadow GIT_DIR can
 * never see; worktree .gitignore files and the global XDG excludes work
 * through the work-tree / HOME as usual).
 */
export async function openShadow(
	workTree: string,
	sessionId: string,
	options: OpenShadowOptions = {},
): Promise<ShadowRepo> {
	const cacheRoot =
		options.cacheRoot ??
		join(homedir(), ".omp", "agent", "cache", "omp-rewind");
	const noRepo = options.noRepo ?? false;
	const key = createHash("sha256").update(workTree).digest("hex").slice(0, 16);
	const gitDir = join(cacheRoot, key);
	try {
		await access(join(gitDir, "HEAD"));
	} catch {
		await mkdir(gitDir, { recursive: true });
		await git(["init", "--bare", "--quiet", gitDir], cacheRoot);
		await git(["config", "gc.auto", "0"], gitDir);
	}
	await mkdir(join(gitDir, "info"), { recursive: true });

	let realInfoExclude: string | null = null;
	if (!noRepo) {
		const realGitDir = await git(
			["rev-parse", "--absolute-git-dir"],
			workTree,
		).catch(() => "");
		if (realGitDir.length > 0) {
			realInfoExclude = join(realGitDir, "info", "exclude");
		}
	}

	// Self-heal shadows poisoned by pre-fix `prune all` (gc --prune=now used
	// to run while index files survived, leaving them pointing at deleted
	// blobs; write-tree does not validate object existence). Scope: THIS
	// session only — check OUR ref prefix, drop OUR index. A global zero-ref
	// check would let another session's refs mask a poisoned index here
	// (B checkpoints after the bad prune → resume A → global refs non-empty
	// → A keeps publishing dead-blob trees). Foreign indexes are never
	// touched: their session may be mid-checkpoint (deleting its index
	// yields an EMPTY-tree checkpoint — restoring that wipes a worktree);
	// stale ones die at their own session's next openShadow, like this one.
	// Index files are per (session, PROCESS): two omp processes can /resume
	// the SAME sessionId, and a shared index file would reintroduce the
	// rm-during-peer-write → empty-tree hazard. Per-pid isolation costs one
	// full re-hash per process start; no cross-process file is ever shared.
	const sessionIndex = join(
		gitDir,
		`index-${refComponent(sessionId)}-${process.pid}`,
	);
	const ownRef = await git(
		["--git-dir", gitDir, "for-each-ref", "--count=1", "--format=x",
			`${REF_BASE}/${refComponent(sessionId)}/`],
		cacheRoot,
	).catch(() => "");
	if (ownRef.length === 0) {
		await rm(sessionIndex, { force: true }).catch(() => {});
	}
	const shadow: ShadowRepo = {
		gitDir,
		workTree,
		indexFile: sessionIndex,
		noRepo,
		realInfoExclude,
	};
	await refreshShadowExcludes(shadow);
	return shadow;
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

/** `-c core.excludesFile=<effective>` for shadow commands (repo mode). */
async function excludesFileConfig(shadow: ShadowRepo): Promise<string[]> {
	if (shadow.noRepo) return [];
	const excludesFile = await git(
		["config", "--path", "--get", "core.excludesFile"],
		shadow.workTree,
	).catch(() => "");
	return excludesFile.length > 0
		? ["-c", `core.excludesFile=${excludesFile}`]
		: [];
}

/**
 * Sync the shadow index to the current workspace state and return the tree.
 *
 * Ignore contract (all four sources, live-refreshed every sync):
 * 1. `add -A` respects worktree .gitignore + mirrored info/exclude +
 *    forwarded core.excludesFile (-c, native precedence slot).
 * 2. EVICTION: git never applies ignore rules to already-tracked paths, and
 *    the shadow index is persistent — a file snapshotted BEFORE an ignore
 *    rule appeared stays tracked forever, and restoring an older checkpoint
 *    would DELETE it from disk. So every sync evicts shadow-tracked paths
 *    that are now ignored — unless the REAL repo tracks them (those are the
 *    legitimate tracked+ignored set, force-added below).
 * 3. FORCE-ADD: files the REAL repo tracks that ignore rules hide from
 *    `add -A` — filtered to paths on disk (`add` fatals on pathspecs
 *    matching nothing; deleted-but-tracked deletions are already staged).
 *
 * Eviction failures THROW: a checkpoint that might still contain
 * newly-ignored files is a data-loss hazard on restore, better no
 * checkpoint (visible ⚠) than a poisoned one.
 */
export async function syncShadowIndex(shadow: ShadowRepo): Promise<string> {
	await refreshShadowExcludes(shadow);
	const addConfig = await excludesFileConfig(shadow);
	await shadowGit(shadow, [...addConfig, "add", "-A", "."]);

	// Real repo's tracked+ignored set (empty in folder mode).
	const realTrackedIgnored = new Set<string>();
	if (!shadow.noRepo) {
		const raw = await git(
			["ls-files", "-ci", "--exclude-standard", "-z"],
			shadow.workTree,
			{ raw: true },
		).catch(() => "");
		for (const path of raw.split("\0")) {
			if (path.length > 0) realTrackedIgnored.add(path);
		}
	}

	// 2. Evict shadow-tracked paths that current rules ignore (late-ignored
	//    files), keeping the real repo's tracked+ignored ones.
	const shadowIgnored = await shadowGit(
		shadow,
		[...addConfig, "ls-files", "-ciz", "--exclude-standard"],
		{ raw: true },
	);
	const evict: string[] = [];
	for (const path of shadowIgnored.split("\0")) {
		if (path.length > 0 && !realTrackedIgnored.has(path)) evict.push(path);
	}
	if (evict.length > 0) {
		await shadowGit(shadow, ["update-index", "--force-remove", "-z", "--stdin"], {
			input: `${evict.join("\0")}\0`,
		});
	}

	// 3. Force-add the real tracked+ignored set (only what exists on disk).
	if (realTrackedIgnored.size > 0) {
		const present: string[] = [];
		for (const path of realTrackedIgnored) {
			try {
				await lstat(join(shadow.workTree, path));
				present.push(path);
			} catch {
				// deleted from disk — add -A already recorded the deletion
			}
		}
		if (present.length > 0) {
			// --literal-pathspecs: ls-files output is literal paths; without it
			// a ":"-prefixed name parses as pathspec magic and fatals the batch.
			await shadowGit(
				shadow,
				[
					"--literal-pathspecs",
					"add",
					"-f",
					"--pathspec-from-file=-",
					"--pathspec-file-nul",
				],
				{ input: `${present.join("\0")}\0` },
			).catch(() => {
				// best-effort: a racing delete must not kill the checkpoint
			});
		}
	}
	return shadowGit(shadow, ["write-tree"]);
}

/**
 * Nested-repo paths recorded as gitlinks (mode 160000) in the session
 * index. `add -A` hard-stops at embedded `.git` boundaries: their CONTENT
 * is neither snapshotted nor restored (each nested repo is its own rewind
 * domain — run omp inside it for full coverage). Callers surface this so
 * folder mode never silently claims coverage it does not have.
 */
export async function listGitlinks(shadow: ShadowRepo): Promise<string[]> {
	const out = await shadowGit(shadow, ["ls-files", "-sz"], {
		raw: true,
	}).catch(() => "");
	const links: string[] = [];
	for (const entry of out.split("\0")) {
		if (entry.startsWith("160000 ")) {
			const tab = entry.indexOf("\t");
			if (tab !== -1) links.push(entry.slice(tab + 1));
		}
	}
	return links;
}

/** Gitlink paths recorded in a checkpoint TREE (mode 160000 entries). */
export async function listTreeGitlinks(
	shadow: ShadowRepo,
	treeSha: string,
): Promise<string[]> {
	const out = await shadowGit(shadow, ["ls-tree", "-rz", treeSha], {
		raw: true,
	}).catch(() => "");
	const links: string[] = [];
	for (const entry of out.split("\0")) {
		if (entry.startsWith("160000 ")) {
			const tab = entry.indexOf("\t");
			if (tab !== -1) links.push(entry.slice(tab + 1));
		}
	}
	return links;
}

// ============================================================================
// Checkpoint CRUD
// ============================================================================

interface RepoHead {
	branch: string;
	headSha: string;
}

/** Branch name + HEAD sha of the REAL repo (read-only; sentinel in folder mode). */
async function readHead(root: string, noRepo: boolean): Promise<RepoHead> {
	if (noRepo) return { branch: NO_REPO_BRANCH, headSha: ZEROS };
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
	const { branch, headSha } = await readHead(root, shadow.noRepo);

	const stagedPatch = shadow.noRepo
		? ""
		: await git(
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

export type RestoreBlockReason =
	| "branch-mismatch"
	| "detached-head-moved"
	| "nested-repos";

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
	const { branch, headSha } = await readHead(root, shadow.noRepo);
	if (branch !== cp.branch) {
		const detail =
			cp.branch === NO_REPO_BRANCH
				? "Checkpoint predates this git repository (it was taken when the workspace was a plain folder); file restore would fight the new repo state."
				: shadow.noRepo
					? `Checkpoint was taken on branch "${cp.branch}" but the workspace is no longer a git repository.`
					: `Checkpoint was taken on "${cp.branch}" but you are on "${branch}". Switch back to "${cp.branch}" to restore files.`;
		throw new RestoreBlockedError("branch-mismatch", detail);
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

	// Embedded repos: gitlinks carry NO content — neither the checkpoint nor
	// the synced index covers the files inside. Guard on current index ∪
	// TARGET TREE (a child present at checkpoint time but since replaced by
	// a plain directory leaves no gitlink in a fresh index, yet applying the
	// gitlink-bearing target tree would delete the replacement's content).
	// Repo mode: gitlinks the REAL repo tracks as 160000 are legitimate
	// submodules — git-native pointer semantics, no block; everything else
	// (untracked embedded repo) is exactly the folder-mode hazard.
	const foreign = new Set<string>([
		...(await listGitlinks(shadow)),
		...(await listTreeGitlinks(shadow, cp.worktreeTreeSha)),
	]);
	if (!shadow.noRepo && foreign.size > 0) {
		const raw = await git(["ls-files", "-sz"], root, { raw: true }).catch(
			() => "",
		);
		for (const entry of raw.split("\0")) {
			if (entry.startsWith("160000 ")) {
				const tab = entry.indexOf("\t");
				if (tab !== -1) foreign.delete(entry.slice(tab + 1));
			}
		}
	}
	if (foreign.size > 0) {
		const shown = [...foreign];
		throw new RestoreBlockedError(
			"nested-repos",
			`Nested git repositories are involved (${shown.slice(0, 3).join(", ")}${foreign.size > 3 ? ", …" : ""}) — in the workspace now, in the target checkpoint, or both — and the outer repo does not track them as submodules. Their files are not covered by checkpoints, so a file restore would be silently partial or destructive. Run omp inside each nested repo for full-fidelity rewind there.`,
		);
	}

	// Currently-ignored paths are outside rewind's jurisdiction in BOTH
	// directions: eviction (syncShadowIndex) stops deletes, and this strip
	// stops WRITES — a checkpoint that captured the path while it was still
	// snapshot-scoped must not clobber (or resurrect) it now. Paths the REAL
	// repo tracks stay restorable (the legitimate tracked+ignored set).
	const targetPaths = await shadowGit(
		shadow,
		["ls-tree", "-r", "--name-only", "-z", cp.worktreeTreeSha],
		{ raw: true },
	);
	const config = await excludesFileConfig(shadow);
	const ignoredNow = await shadowGit(
		shadow,
		[...config, "check-ignore", "-z", "--stdin"],
		{ input: targetPaths, raw: true },
	).catch(() => ""); // exit 1 = none ignored
	const realTracked = new Set<string>();
	if (!shadow.noRepo) {
		const raw = await git(["ls-files", "-z"], root, { raw: true }).catch(
			() => "",
		);
		for (const path of raw.split("\0")) {
			if (path.length > 0) realTracked.add(path);
		}
	}
	const strip = ignoredNow
		.split("\0")
		.filter((path) => path.length > 0 && !realTracked.has(path));

	let applyTree = cp.worktreeTreeSha;
	if (strip.length > 0) {
		// Build a filtered tree in a throwaway index; the session index is
		// untouched until the real read-tree below.
		const tmpIndex = join(shadow.gitDir, `restore-tmp-${process.pid}`);
		const tmpGit = (args: string[], opts: GitRunOptions = {}) =>
			git(
				["--git-dir", shadow.gitDir, "--work-tree", shadow.workTree, ...args],
				shadow.workTree,
				{ ...opts, env: { ...opts.env, GIT_INDEX_FILE: tmpIndex } },
			);
		try {
			await tmpGit(["read-tree", cp.worktreeTreeSha]);
			await tmpGit(["update-index", "--force-remove", "-z", "--stdin"], {
				input: `${strip.join("\0")}\0`,
			});
			applyTree = await tmpGit(["write-tree"]);
		} finally {
			await rm(tmpIndex, { force: true }).catch(() => {});
		}
	}
	await shadowGit(shadow, ["read-tree", "--reset", "-u", applyTree]);

	// 2. Workspace index := HEAD, then replay the staged diff. This is the
	//    single intentional write to the workspace repo — it IS the restore
	//    of the staged/unstaged split the user had. Folder mode has no
	//    workspace repo, so there is nothing to reproduce.
	if (shadow.noRepo) return { stagedRestored: true };
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
	// The jurisdiction rule must hold for the REAL index too: read-tree HEAD
	// or the replayed staged patch can re-insert currently-ignored paths.
	// The cleanup set is derived from the LIVE index — NOT from the target
	// tree (`strip`): a path can be absent from the checkpoint tree yet
	// re-inserted here (HEAD commits it, worktree deletion unstaged at
	// checkpoint time, evicted via rm --cached before restore). Cleanup =
	// (tracked∩ignored NOW, via the real repo's own full ignore stack) −
	// (tracked BEFORE any real-index write): late-inserted ignored paths
	// go, pre-existing legitimate tracked+ignored files stay. check-ignore
	// is deliberately NOT used — it suppresses tracked paths by default,
	// and these paths are tracked again by now. Failures throw (a silently
	// poisoned index defeats the whole rule).
	const postTrackedIgnored = await git(
		["ls-files", "-ciz", "--exclude-standard"],
		root,
		{ raw: true },
	);
	const evict = postTrackedIgnored
		.split("\0")
		.filter((path) => path.length > 0 && !realTracked.has(path));
	if (evict.length > 0) {
		await git(["update-index", "--force-remove", "-z", "--stdin"], root, {
			input: `${evict.join("\0")}\0`,
		});
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

export interface PruneResult {
	/** Refs actually deleted (update-ref -d succeeded). */
	deleted: number;
	/** Refs that matched the scope but failed to delete. */
	failed: number;
	/** `all` only: every per-session index file was removed. */
	indexCleanupOk: boolean;
	/** `all` only: gc ran and succeeded (skipped when cleanup failed). */
	gcOk: boolean;
}

/** Prune target: fixed scopes, or keep-newest-N of the current session. */
export type PruneScope =
	| "current"
	| "others"
	| "all"
	| { keep: number };

/**
 * Delete checkpoint refs. `scope: "current"` deletes only this session's,
 * `scope: "others"` keeps this session and deletes the rest, `scope: "all"`
 * wipes everything (and repacks; objects are never pruned — see below),
 * `{ keep: N }` keeps the current session's N NEWEST checkpoints (by
 * committer date) and deletes its older ones — for "clear what I'll never
 * rewind to" without losing recent restore points.
 *
 * Failures are COUNTED, never silently folded into success: the caller's
 * "pruned N" claim must match what actually happened.
 */
export async function pruneCheckpoints(
	shadow: ShadowRepo,
	scope: PruneScope,
	currentSessionId: string,
): Promise<PruneResult> {
	const session = refComponent(currentSessionId);
	let targets: string[];
	if (typeof scope === "object") {
		// Newest-first by CheckpointMeta.createdAt (millisecond ISO in the
		// commit message) — NOT committerdate: git stores seconds only, so
		// rapid checkpoints tie and the order would be undefined exactly
		// where it matters. Ref name breaks residual ties deterministically.
		const pairs = await shadowGit(shadow, [
			"for-each-ref",
			"--format=%(refname)%09%(objectname)",
			`${REF_BASE}/${session}/`,
		]).catch(() => "");
		const refBySha = new Map<string, string[]>();
		for (const line of pairs.split("\n")) {
			const [ref, sha] = line.split("\t");
			if (!ref || !sha) continue;
			const list = refBySha.get(sha) ?? [];
			list.push(ref);
			refBySha.set(sha, list);
		}
		// One batch process for all commit bodies; createdAt per sha.
		const batch = await shadowGit(shadow, ["cat-file", "--batch"], {
			input: `${[...refBySha.keys()].join("\n")}\n`,
			raw: true,
		}).catch(() => "");
		const createdBySha = new Map<string, string>();
		let currentSha = "";
		for (const line of batch.split("\n")) {
			const header = /^([0-9a-f]{40,64}) commit \d+$/.exec(line);
			if (header?.[1]) {
				currentSha = header[1];
				continue;
			}
			if (currentSha && line.startsWith("{")) {
				try {
					const meta = JSON.parse(line) as CheckpointMeta;
					if (meta.createdAt) createdBySha.set(currentSha, meta.createdAt);
				} catch {
					// unreadable meta → sha stays absent → ref is KEPT (below)
				}
			}
		}
		// Fail-closed ordering: only refs whose createdAt is READABLE compete
		// for deletion. Unknown-age refs are always kept (survivors may
		// exceed N) — deleting what we cannot order would be arbitrary, and
		// a failed batch read must degrade to a no-op, not a purge.
		const entries: { ref: string; createdAt: string }[] = [];
		for (const [sha, refs] of refBySha) {
			const createdAt = createdBySha.get(sha);
			if (createdAt === undefined) continue;
			for (const ref of refs) entries.push({ ref, createdAt });
		}
		entries.sort((a, b) =>
			a.createdAt === b.createdAt
				? b.ref.localeCompare(a.ref)
				: b.createdAt.localeCompare(a.createdAt),
		);
		targets = entries.slice(Math.max(0, scope.keep)).map((e) => e.ref);
	} else {
		targets = (await listCheckpointRefs(shadow))
			.filter(({ sessionComponent }) =>
				scope === "others"
					? sessionComponent !== session
					: scope === "current"
						? sessionComponent === session
						: true,
			)
			.map(({ ref }) => ref);
	}
	let deleted = 0;
	let failed = 0;
	for (const ref of targets) {
		const ok = await shadowGit(shadow, ["update-ref", "-d", ref]).then(
			() => true,
			() => false,
		);
		if (ok) deleted++;
		else failed++;
	}
	let indexCleanupOk = true;
	let gcOk = true;
	if (scope === "all") {
		// Cross-process safety WITHOUT a lock (presence checks are UX, not a
		// sync primitive — a peer can appear between check and gc):
		// - NO object pruning, ever: a peer's persistent index may reference
		//   blobs of ANY age kept alive only by that index (gc cannot see our
		//   index files as roots), and any prune window poisons its next
		//   checkpoint. `gc --no-prune` (the documented "never delete loose
		//   objects" contract) repacks reachable objects and keeps the rest;
		//   true disk reclaim needs an exclusive cross-process lock — future
		//   work.
		// - delete ONLY OUR OWN index file (we are quiesced by the caller);
		//   other sessions' indexes are theirs — deleting one mid-checkpoint
		//   makes write-tree read a MISSING index and emit an EMPTY tree
		//   (restoring that wipes a worktree).
		try {
			await rm(shadow.indexFile, { force: true });
		} catch {
			indexCleanupOk = false;
		}
		gcOk = indexCleanupOk
			? await shadowGit(shadow, ["gc", "--no-prune", "--quiet"]).then(
					() => true,
					() => false,
				)
			: false;
	}
	return { deleted, failed, indexCleanupOk, gcOk };
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
