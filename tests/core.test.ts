/**
 * omp-rewind core tests — exercise the real git contract:
 * snapshot fidelity, HEAD immutability, untracked safety, staged-state
 * roundtrip, cross-branch blocking, ref hygiene, pruning — and the shadow
 * invariant: the workspace's own .git gains no refs and no objects.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkpointRef,
	createCheckpoint,
	diffTreeStat,
	git,
	listCheckpointRefs,
	listGitlinks,
	listTreeGitlinks,
	loadCheckpoint,
	NO_REPO_BRANCH,
	openShadow,
	pruneCheckpoints,
	refComponent,
	RestoreBlockedError,
	restoreCheckpoint,
	type ShadowRepo,
} from "../src/core.ts";

let repo: string;
let cacheRoot: string;
let shadow: ShadowRepo;

const SESSION = "11111111-2222-3333-4444-555555555555";

async function initRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "omp-rewind-test-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@test"], dir);
	await git(["config", "user.name", "test"], dir);
	await writeFile(join(dir, "a.txt"), "original\n");
	await git(["add", "."], dir);
	await git(["commit", "-m", "initial"], dir);
	// resolve /tmp symlink on macOS so git and fs paths agree
	return git(["rev-parse", "--show-toplevel"], dir);
}

/** Fingerprint of the REAL repo's .git: all refs + object count. */
async function realGitFingerprint(root: string): Promise<string> {
	const refs = await git(["for-each-ref", "--format=%(refname) %(objectname)"], root);
	const objects = await git(["count-objects", "-v"], root);
	const counts = objects
		.split("\n")
		.filter((l) => l.startsWith("count:") || l.startsWith("in-pack:"))
		.join(" ");
	return `${refs}\n${counts}`;
}

beforeEach(async () => {
	repo = await initRepo();
	cacheRoot = await mkdtemp(join(tmpdir(), "omp-rewind-cache-"));
	shadow = await openShadow(repo, SESSION, { cacheRoot });
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
	await rm(cacheRoot, { recursive: true, force: true });
});

const opts = (entryId: string) => ({ shadow, sessionId: SESSION, entryId });

test("checkpointing writes nothing to the workspace .git", async () => {
	const before = await realGitFingerprint(repo);

	await createCheckpoint({ ...opts("entry-1"), label: "turn-start" });
	await writeFile(join(repo, "b.txt"), "more\n");
	await createCheckpoint(opts("entry-2"));

	expect(await realGitFingerprint(repo)).toBe(before);
	// refs exist only in the shadow
	expect((await listCheckpointRefs(shadow)).length).toBe(2);
	const realRefs = await git(["for-each-ref", "refs/omp-rewind/"], repo);
	expect(realRefs).toBe("");
});

test("checkpoint → load roundtrips metadata", async () => {
	const cp = await createCheckpoint({ ...opts("entry-1"), label: "turn-start" });
	const loaded = await loadCheckpoint(shadow, SESSION, "entry-1");
	expect(loaded).not.toBeNull();
	expect(loaded!.entryId).toBe("entry-1");
	expect(loaded!.branch).toBe("main");
	expect(loaded!.label).toBe("turn-start");
	expect(loaded!.worktreeTreeSha).toBe(cp.worktreeTreeSha);
});

test("restore reverts tracked edits and deletes new untracked files", async () => {
	const cp = await createCheckpoint(opts("entry-1"));

	await writeFile(join(repo, "a.txt"), "mutated\n");
	await writeFile(join(repo, "new-file.txt"), "created after checkpoint\n");
	await restoreCheckpoint(shadow, cp);

	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("original\n");
	expect(stat(join(repo, "new-file.txt"))).rejects.toThrow();
});

test("restore resurrects files deleted after the checkpoint", async () => {
	await writeFile(join(repo, "doomed.txt"), "keep me\n");
	const cp = await createCheckpoint(opts("entry-1"));

	await rm(join(repo, "doomed.txt"));
	await restoreCheckpoint(shadow, cp);

	expect(await readFile(join(repo, "doomed.txt"), "utf-8")).toBe("keep me\n");
});

test("restore preserves untracked files that existed at checkpoint time", async () => {
	await writeFile(join(repo, "preexisting.txt"), "before checkpoint\n");
	const cp = await createCheckpoint(opts("entry-1"));

	await writeFile(join(repo, "preexisting.txt"), "modified later\n");
	await restoreCheckpoint(shadow, cp);

	// Content comes back from the snapshot (full-workspace scope) …
	expect(await readFile(join(repo, "preexisting.txt"), "utf-8")).toBe(
		"before checkpoint\n",
	);
	// … and it is still untracked in the REAL repo, not silently staged.
	const status = await git(["status", "--porcelain", "preexisting.txt"], repo);
	expect(status.startsWith("??")).toBe(true);
});

test("restore never deletes gitignored files", async () => {
	await writeFile(join(repo, ".gitignore"), "secret.env\n");
	await git(["add", ".gitignore"], repo);
	await git(["commit", "-m", "ignore"], repo);
	const cp = await createCheckpoint(opts("entry-1"));

	await writeFile(join(repo, "secret.env"), "TOKEN=x\n");
	await restoreCheckpoint(shadow, cp);

	expect(await readFile(join(repo, "secret.env"), "utf-8")).toBe("TOKEN=x\n");
});

test("restore keeps HEAD and later commits intact (files-only contract)", async () => {
	const cp = await createCheckpoint(opts("entry-1"));

	await writeFile(join(repo, "a.txt"), "committed change\n");
	await git(["add", "a.txt"], repo);
	await git(["commit", "-m", "later commit"], repo);
	const headAfterCommit = await git(["rev-parse", "HEAD"], repo);

	const result = await restoreCheckpoint(shadow, cp);

	// HEAD unchanged — commit B survives on the branch.
	expect(await git(["rev-parse", "HEAD"], repo)).toBe(headAfterCommit);
	// Working tree matches the checkpoint, shown as uncommitted changes.
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("original\n");
	const status = await git(["status", "--porcelain"], repo);
	expect(status).toContain("a.txt");
	// No staged patch existed, so the split trivially restored.
	expect(result.stagedRestored).toBe(true);
});

test("restore reproduces the staged/unstaged split", async () => {
	await writeFile(join(repo, "a.txt"), "staged content\n");
	await git(["add", "a.txt"], repo);
	await writeFile(join(repo, "a.txt"), "unstaged on top\n");
	const cp = await createCheckpoint(opts("entry-1"));
	expect(cp.stagedPatchBlob).not.toBeNull();

	await git(["reset", "--hard", "HEAD"], repo);
	const result = await restoreCheckpoint(shadow, cp);

	expect(result.stagedRestored).toBe(true);
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("unstaged on top\n");
	const staged = await git(["diff", "--cached", "--name-only"], repo);
	expect(staged).toContain("a.txt");
	const unstaged = await git(["diff", "--name-only"], repo);
	expect(unstaged).toContain("a.txt");
});

test("staged split degrades gracefully when HEAD moved", async () => {
	await writeFile(join(repo, "a.txt"), "staged content\n");
	await git(["add", "a.txt"], repo);
	const cp = await createCheckpoint(opts("entry-1"));
	expect(cp.stagedPatchBlob).not.toBeNull();

	// Commit the staged change: the old staged patch no longer applies to HEAD.
	await git(["commit", "-m", "absorb staged"], repo);
	const result = await restoreCheckpoint(shadow, cp);

	// Files still restored correctly even though the split was lost.
	expect(result.stagedRestored).toBe(false);
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("staged content\n");
});

test("cross-branch restore is blocked", async () => {
	const cp = await createCheckpoint(opts("entry-1"));
	await git(["checkout", "-b", "feature"], repo);

	await expect(restoreCheckpoint(shadow, cp)).rejects.toThrow(
		RestoreBlockedError,
	);
	// and the worktree was not touched
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("original\n");
});

test("checkpoint captures nested untracked files", async () => {
	await mkdir(join(repo, "deep/nested"), { recursive: true });
	await writeFile(join(repo, "deep/nested/file.txt"), "nested\n");
	const cp = await createCheckpoint(opts("entry-1"));

	await rm(join(repo, "deep"), { recursive: true });
	await restoreCheckpoint(shadow, cp);

	expect(await readFile(join(repo, "deep/nested/file.txt"), "utf-8")).toBe(
		"nested\n",
	);
});

test("tracked-but-ignored files are still snapshotted", async () => {
	// a file that is tracked in the real repo but matches .gitignore
	await writeFile(join(repo, "generated.lock"), "v1\n");
	await git(["add", "-f", "generated.lock"], repo);
	await git(["commit", "-m", "lockfile"], repo);
	await writeFile(join(repo, ".gitignore"), "*.lock\n");

	const cp = await createCheckpoint(opts("entry-1"));
	await writeFile(join(repo, "generated.lock"), "v2\n");
	await restoreCheckpoint(shadow, cp);

	expect(await readFile(join(repo, "generated.lock"), "utf-8")).toBe("v1\n");
});

test("refComponent sanitizes hostile ids and keeps refs valid", async () => {
	expect(refComponent("a/b:c d*e")).toBe("a_b_c_d_e");
	expect(refComponent(".hidden")).toBe("_hidden");
	expect(refComponent("x.lock")).toBe("x_lock");
	expect(refComponent("")).toBe("_");

	// A hostile entry ID still produces a usable ref.
	const cp = await createCheckpoint({
		shadow,
		sessionId: "s p a c e",
		entryId: "we/ird~id",
	});
	expect(cp.entryId).toBe("we/ird~id");
	const loaded = await loadCheckpoint(shadow, "s p a c e", "we/ird~id");
	expect(loaded).not.toBeNull();
});

test("second checkpoint on the same entry overwrites the ref", async () => {
	await createCheckpoint(opts("entry-1"));
	await writeFile(join(repo, "a.txt"), "v2\n");
	const cp2 = await createCheckpoint(opts("entry-1"));

	const refs = await listCheckpointRefs(shadow);
	expect(refs.length).toBe(1);
	const loaded = await loadCheckpoint(shadow, SESSION, "entry-1");
	// latest content wins
	expect(loaded!.worktreeTreeSha).toBe(cp2.worktreeTreeSha);
});

test("prune scopes: current deletes only this session; others keeps it; all wipes", async () => {
	await createCheckpoint(opts("entry-1"));
	await createCheckpoint({
		shadow,
		sessionId: "other-session",
		entryId: "entry-9",
	});

	// current: only this session's ref goes; the other session survives
	const resultCurrent = await pruneCheckpoints(shadow, "current", SESSION);
	expect(resultCurrent).toEqual({
		deleted: 1,
		failed: 0,
		indexCleanupOk: true,
		gcOk: true,
	});
	let refs = await listCheckpointRefs(shadow);
	expect(refs.length).toBe(1);
	expect(refs[0]!.sessionComponent).toBe("other-session");

	// re-create ours, then others: the other session goes, ours survives
	await createCheckpoint(opts("entry-1"));
	const resultOthers = await pruneCheckpoints(shadow, "others", SESSION);
	expect(resultOthers).toEqual({
		deleted: 1,
		failed: 0,
		indexCleanupOk: true,
		gcOk: true,
	});
	refs = await listCheckpointRefs(shadow);
	expect(refs.length).toBe(1);
	expect(refs[0]!.ref).toBe(checkpointRef(SESSION, "entry-1"));

	const resultAll = await pruneCheckpoints(shadow, "all", SESSION);
	expect(resultAll).toEqual({
		deleted: 1,
		failed: 0,
		indexCleanupOk: true,
		gcOk: true,
	});
	refs = await listCheckpointRefs(shadow);
	expect(refs.length).toBe(0);
});

test("diffTreeStat is empty for identical trees and non-empty for changes", async () => {
	const cp1 = await createCheckpoint(opts("entry-1"));
	expect(await diffTreeStat(shadow, cp1.worktreeTreeSha, cp1.worktreeTreeSha)).toBe(
		"",
	);

	await writeFile(join(repo, "a.txt"), "changed\n");
	const cp2 = await createCheckpoint(opts("entry-2"));
	const stat2 = await diffTreeStat(
		shadow,
		cp1.worktreeTreeSha,
		cp2.worktreeTreeSha,
	);
	expect(stat2).toContain("a.txt");
});

test("checkpoint works on unborn branch (no commits yet)", async () => {
	const bare = await mkdtemp(join(tmpdir(), "omp-rewind-unborn-"));
	try {
		await git(["init", "-b", "main"], bare);
		await git(["config", "user.email", "t@t"], bare);
		await git(["config", "user.name", "t"], bare);
		const root = await git(["rev-parse", "--show-toplevel"], bare);
		const unbornShadow = await openShadow(root, "s", { cacheRoot });
		await writeFile(join(root, "first.txt"), "hello\n");

		const cp = await createCheckpoint({
			shadow: unbornShadow,
			sessionId: "s",
			entryId: "e",
		});
		await writeFile(join(root, "first.txt"), "mutated\n");
		await restoreCheckpoint(unbornShadow, cp);
		expect(await readFile(join(root, "first.txt"), "utf-8")).toBe("hello\n");
	} finally {
		await rm(bare, { recursive: true, force: true });
	}
});

test("openShadow is idempotent and isolates per-session index files", async () => {
	const again = await openShadow(repo, "another-session", { cacheRoot });
	expect(again.gitDir).toBe(shadow.gitDir);
	expect(again.indexFile).not.toBe(shadow.indexFile);
});

// ============================================================================
// Folder mode (workspace is not a git repository)
// ============================================================================

/** Plain temp dir, symlinks resolved so git and fs paths agree (macOS /tmp). */
async function initFolder(): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), "omp-rewind-folder-")));
}

const folderOpts = (s: ShadowRepo, entryId: string) => ({
	shadow: s,
	sessionId: SESSION,
	entryId,
});

test("folder mode: checkpoint → restore roundtrip without a git repo", async () => {
	const dir = await initFolder();
	try {
		await writeFile(join(dir, "a.txt"), "original\n");
		await writeFile(join(dir, "b.txt"), "keep me\n");
		const fShadow = await openShadow(dir, SESSION, { cacheRoot, noRepo: true });
		const cp = await createCheckpoint(folderOpts(fShadow, "entry-1"));
		expect(cp.branch).toBe(NO_REPO_BRANCH);
		expect(cp.stagedPatchBlob).toBeNull();

		await writeFile(join(dir, "a.txt"), "mutated\n");
		await rm(join(dir, "b.txt"));
		await writeFile(join(dir, "new.txt"), "created later\n");

		const result = await restoreCheckpoint(fShadow, cp);
		expect(result.stagedRestored).toBe(true);
		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("original\n");
		expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("keep me\n");
		await expect(stat(join(dir, "new.txt"))).rejects.toThrow();
		// the workspace stayed repo-free: nothing created a .git there
		await expect(stat(join(dir, ".git"))).rejects.toThrow();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("folder mode: default excludes keep node_modules out of snapshots", async () => {
	const dir = await initFolder();
	try {
		await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(dir, "node_modules", "pkg", "index.js"), "x\n");
		await writeFile(join(dir, "keep.txt"), "keep\n");
		const fShadow = await openShadow(dir, SESSION, { cacheRoot, noRepo: true });
		const cp = await createCheckpoint(folderOpts(fShadow, "entry-1"));

		const files = await git(
			["--git-dir", fShadow.gitDir, "ls-tree", "-r", "--name-only", cp.worktreeTreeSha],
			dir,
		);
		expect(files).toBe("keep.txt");

		// excluded files are invisible to restore: never reverted, never deleted
		await writeFile(join(dir, "node_modules", "pkg", "extra.js"), "y\n");
		await restoreCheckpoint(fShadow, cp);
		expect(
			await readFile(join(dir, "node_modules", "pkg", "extra.js"), "utf-8"),
		).toBe("y\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("folder mode: a real .gitignore still overrides the default excludes", async () => {
	const dir = await initFolder();
	try {
		await writeFile(join(dir, ".gitignore"), "!dist/\nsecret.env\n");
		await mkdir(join(dir, "dist"), { recursive: true });
		await writeFile(join(dir, "dist", "bundle.js"), "x\n");
		await writeFile(join(dir, "secret.env"), "TOKEN=x\n");
		const fShadow = await openShadow(dir, SESSION, { cacheRoot, noRepo: true });
		const cp = await createCheckpoint(folderOpts(fShadow, "entry-1"));

		const files = await git(
			["--git-dir", fShadow.gitDir, "ls-tree", "-r", "--name-only", cp.worktreeTreeSha],
			dir,
		);
		expect(files).toContain("dist/bundle.js");
		expect(files).not.toContain("secret.env");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("folder-mode checkpoint is blocked once the folder becomes a git repo", async () => {
	const dir = await initFolder();
	try {
		await writeFile(join(dir, "a.txt"), "original\n");
		const fShadow = await openShadow(dir, SESSION, { cacheRoot, noRepo: true });
		const cp = await createCheckpoint(folderOpts(fShadow, "entry-1"));

		await git(["init", "-b", "main"], dir);
		const rShadow = await openShadow(dir, SESSION, { cacheRoot });
		await expect(restoreCheckpoint(rShadow, cp)).rejects.toThrow(
			RestoreBlockedError,
		);
		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("original\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("reopening in repo mode clears folder-mode excludes", async () => {
	// A folder-mode open seeds info/exclude in the shared shadow; a later
	// repo-mode open on the same workspace must clear it so untracked dist/
	// in a real repo is still snapshotted.
	await openShadow(repo, SESSION, { cacheRoot, noRepo: true });
	const again = await openShadow(repo, SESSION, { cacheRoot });
	await mkdir(join(repo, "dist"), { recursive: true });
	await writeFile(join(repo, "dist", "bundle.js"), "x\n");
	const cp = await createCheckpoint(folderOpts(again, "entry-1"));
	const files = await git(
		["--git-dir", again.gitDir, "ls-tree", "-r", "--name-only", cp.worktreeTreeSha],
		repo,
	);
	expect(files).toContain("dist/bundle.js");
});

// ============================================================================
// Regressions: dirty-repo checkpointing and prune-all poisoning
// ============================================================================

test("checkpoint survives a deleted-but-tracked file (dirty refactor state)", async () => {
	// b.txt is tracked, then deleted from disk WITHOUT staging the deletion —
	// the exact state of a mid-refactor branch. The old force-add passed every
	// ls-files path as a pathspec; git fatals on pathspecs matching nothing,
	// so EVERY checkpoint failed silently and the status stayed at 0.
	await writeFile(join(repo, "b.txt"), "doomed\n");
	await git(["add", "b.txt"], repo);
	await git(["commit", "-m", "add b"], repo);
	await rm(join(repo, "b.txt"));

	const cp = await createCheckpoint(opts("entry-1"));

	// snapshot reflects disk: a.txt present, b.txt absent
	const files = await git(
		["--git-dir", shadow.gitDir, "ls-tree", "-r", "--name-only", cp.worktreeTreeSha],
		repo,
	);
	expect(files).toContain("a.txt");
	expect(files).not.toContain("b.txt");

	// and restore still works: resurrect nothing, keep the deletion
	await writeFile(join(repo, "a.txt"), "mutated\n");
	await restoreCheckpoint(shadow, cp);
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("original\n");
	await expect(stat(join(repo, "b.txt"))).rejects.toThrow();
});

test("checkpoints after prune-all are restorable (no dead-blob poisoning)", async () => {
	// prune all runs gc --prune=now; a persistent per-session index surviving
	// it would keep blob SHAs that no longer exist. write-tree does NOT
	// validate object existence, so the next checkpoint would "succeed" while
	// referencing dead objects — unrestorable. The fix drops index files on
	// prune all; this test locks the full loop.
	await writeFile(join(repo, "data.txt"), "precious\n");
	await createCheckpoint(opts("entry-1"));

	const pruned = await pruneCheckpoints(shadow, "all", SESSION);
	expect(pruned.deleted).toBeGreaterThan(0);
	expect(pruned.failed).toBe(0);
	expect(pruned.indexCleanupOk).toBe(true);

	// same session continues: next checkpoint must be self-contained
	const cp = await createCheckpoint(opts("entry-2"));
	await writeFile(join(repo, "data.txt"), "mutated\n");
	await restoreCheckpoint(shadow, cp);
	expect(await readFile(join(repo, "data.txt"), "utf-8")).toBe("precious\n");
});

test("tracked-but-ignored files force-add only what exists on disk", async () => {
	// tracked + ignored + still on disk → snapshotted (the -ci set);
	// tracked + ignored + deleted     → recorded as deleted, no fatal.
	await writeFile(join(repo, ".gitignore"), "*.secret\n");
	await writeFile(join(repo, "keep.secret"), "keep\n");
	await writeFile(join(repo, "gone.secret"), "gone\n");
	await git(["add", "-f", "keep.secret", "gone.secret", ".gitignore"], repo);
	await git(["commit", "-m", "ignored pair"], repo);
	await rm(join(repo, "gone.secret"));

	const cp = await createCheckpoint(opts("entry-1"));
	const files = await git(
		["--git-dir", shadow.gitDir, "ls-tree", "-r", "--name-only", cp.worktreeTreeSha],
		repo,
	);
	expect(files).toContain("keep.secret");
	expect(files).not.toContain("gone.secret");
});

test("openShadow self-heal is per-session: own index dropped, foreign kept", async () => {
	// A's index is stale/poisoned (A has no refs); B has refs and a live
	// index. Opening A must drop ONLY A's index — B's refs must not mask
	// A's poison (global zero-ref check would), and B's index must never
	// be touched (its session may be mid-checkpoint; a deleted index makes
	// write-tree emit an EMPTY tree — restoring that wipes a worktree).
	await writeFile(join(repo, "x.txt"), "x\n");
	const bShadow = await openShadow(repo, "session-b", { cacheRoot });
	await createCheckpoint({
		shadow: bShadow,
		sessionId: "session-b",
		entryId: "e1",
	}); // B: ref + B's own index file
	const aIndex = join(shadow.gitDir, `index-session-a-${process.pid}`);
	await writeFile(aIndex, "garbage"); // A: stale index, zero refs

	const aShadow = await openShadow(repo, "session-a", { cacheRoot });
	await expect(stat(aIndex)).rejects.toThrow(); // A's dropped
	expect((await stat(bShadow.indexFile)).size).toBeGreaterThan(0); // B's untouched
	expect((await listCheckpointRefs(aShadow)).length).toBe(1); // B's ref kept

	// A keeps working end to end on its fresh index
	const cp = await createCheckpoint({
		shadow: aShadow,
		sessionId: "session-a",
		entryId: "e2",
	});
	await writeFile(join(repo, "x.txt"), "mutated\n");
	await restoreCheckpoint(aShadow, cp);
	expect(await readFile(join(repo, "x.txt"), "utf-8")).toBe("x\n");
});

test("prune all never deletes unreachable objects (no-lock contract)", async () => {
	await createCheckpoint(opts("entry-1"));
	// an unreachable loose blob — stand-in for a peer's in-flight write
	const blob = await git(
		["--git-dir", shadow.gitDir, "hash-object", "-w", "--stdin"],
		repo,
		{ input: "peer-in-flight\n" },
	);
	const result = await pruneCheckpoints(shadow, "all", SESSION);
	expect(result.gcOk).toBe(true);
	// cat-file -e exits non-zero (throws) if the object was pruned
	await git(["--git-dir", shadow.gitDir, "cat-file", "-e", blob], repo);
});

// ============================================================================
// git() runner + pathspec boundary contracts
// ============================================================================

test("force-add survives pathspec metacharacters in tracked-ignored names", async () => {
	// `odd[1].secret` self-heals (git tries literal equality before glob),
	// but a name starting with `:` is parsed as pathspec MAGIC — without
	// --literal-pathspecs the whole force-add batch fatals and the catch
	// swallows it: every tracked+ignored file silently missing from the
	// snapshot.
	await writeFile(join(repo, ".gitignore"), "*.secret\n");
	await writeFile(join(repo, "odd[1].secret"), "meta\n");
	await writeFile(join(repo, ":colon.secret"), "magic\n");
	await writeFile(join(repo, "plain.secret"), "plain\n");
	await git(
		["--literal-pathspecs", "add", "-f", "odd[1].secret", ":colon.secret", "plain.secret", ".gitignore"],
		repo,
	);
	await git(["commit", "-m", "metachar"], repo);

	const cp = await createCheckpoint(opts("entry-1"));
	const files = await git(
		["--git-dir", shadow.gitDir, "ls-tree", "-r", "--name-only", cp.worktreeTreeSha],
		repo,
	);
	expect(files).toContain("odd[1].secret");
	expect(files).toContain(":colon.secret");
	expect(files).toContain("plain.secret");
});

test("inherited GIT_INDEX_FILE/GIT_DIR cannot retarget checkpoint git calls", async () => {
	// A user shell exporting GIT_INDEX_FILE poisons every real-repo call
	// (staged split reads/writes the wrong index) unless the runner strips
	// repo-targeting vars it did not set itself.
	const savedIndex = process.env.GIT_INDEX_FILE;
	const savedDir = process.env.GIT_DIR;
	process.env.GIT_INDEX_FILE = join(tmpdir(), "poisoned-index-does-not-exist");
	process.env.GIT_DIR = join(tmpdir(), "poisoned-gitdir-does-not-exist");
	try {
		await writeFile(join(repo, "a.txt"), "staged half\n");
		await git(["add", "a.txt"], repo);
		await writeFile(join(repo, "a.txt"), "staged half\nunstaged half\n");

		const cp = await createCheckpoint(opts("entry-1"));
		expect(cp.stagedPatchBlob).not.toBeNull();

		await git(["checkout", "--", "a.txt"], repo).catch(() => {});
		await writeFile(join(repo, "a.txt"), "mutated\n");
		const result = await restoreCheckpoint(shadow, cp);
		expect(result.stagedRestored).toBe(true);
		const staged = await git(["diff", "--cached", "--name-only"], repo);
		expect(staged).toContain("a.txt");
	} finally {
		if (savedIndex === undefined) delete process.env.GIT_INDEX_FILE;
		else process.env.GIT_INDEX_FILE = savedIndex;
		if (savedDir === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = savedDir;
	}
});

test("entry ids ending in a dot produce valid refs", async () => {
	expect(refComponent("e.")).not.toMatch(/\.$/);
	const cp = await createCheckpoint(opts("entry."));
	const loaded = await loadCheckpoint(shadow, SESSION, "entry.");
	expect(loaded?.worktreeTreeSha).toBe(cp.worktreeTreeSha);
});

test("large stdin to a fast-exiting git does not crash (EPIPE handled)", async () => {
	// `git version` exits without reading stdin; the buffered 8 MiB write
	// EPIPEs. Without a stdin error handler that is an uncaught stream error.
	const out = await git(["version"], repo, { input: "x".repeat(8 * 1024 * 1024) });
	expect(out).toContain("git version");
});

test("staged split with multibyte content survives pipe-chunked transport", async () => {
	// 384 KiB of 3-byte chars: a 64 KiB pipe chunk boundary always splits a
	// character. Per-chunk Buffer→string decoding corrupts the patch (U+FFFD),
	// and the staged restore degrades or corrupts.
	const big = "中".repeat(128 * 1024);
	await writeFile(join(repo, "big.txt"), big);
	await git(["add", "big.txt"], repo);

	const cp = await createCheckpoint(opts("entry-1"));
	expect(cp.stagedPatchBlob).not.toBeNull();

	await git(["read-tree", "HEAD"], repo); // drop staged state
	const result = await restoreCheckpoint(shadow, cp);
	expect(result.stagedRestored).toBe(true);
	const stagedBlob = await git(["show", ":big.txt"], repo, { raw: true });
	expect(stagedBlob).toBe(big);
});

test("files ignored only via real info/exclude or local excludesFile survive restore", async () => {
	// The shadow's GIT_DIR is the shadow — it never reads the REAL repo's
	// .git/info/exclude or repo-local core.excludesFile. Files ignored only
	// there entered the shadow index as plain untracked; restoring an older
	// checkpoint then DELETED them (read-tree --reset -u, target tree lacks
	// them). Data loss, violating the README safety promise.
	const cp = await createCheckpoint(opts("entry-1"));

	// SAME session, NO reopen: hot edits to both sources must be honored by
	// the very next sync (restore itself runs syncShadowIndex).
	await writeFile(join(repo, ".git", "info", "exclude"), "secret.env\n");
	await writeFile(join(repo, "secret.env"), "TOKEN=x\n");
	// excludesFile lives OUTSIDE the workTree (like ~/.config/git/ignore) —
	// inside it would itself be snapshot-scoped and deleted by the restore.
	const myignore = join(cacheRoot, "myignore");
	await writeFile(myignore, "local.env\n");
	await git(["config", "core.excludesFile", myignore], repo);
	await writeFile(join(repo, "local.env"), "LOCAL=y\n");

	// restore the pre-existing checkpoint: both files must SURVIVE
	await restoreCheckpoint(shadow, cp);
	expect(await readFile(join(repo, "secret.env"), "utf-8")).toBe("TOKEN=x\n");
	expect(await readFile(join(repo, "local.env"), "utf-8")).toBe("LOCAL=y\n");

	// and they never enter new snapshots either
	const cp2 = await createCheckpoint(opts("entry-2"));
	const files = await git(
		["--git-dir", shadow.gitDir, "ls-tree", "-r", "--name-only", cp2.worktreeTreeSha],
		repo,
	);
	expect(files).not.toContain("secret.env");
	expect(files).not.toContain("local.env");
});

test("a file ignored AFTER being snapshotted survives restoring an older checkpoint", async () => {
	// Shadow's persistent index: once tracked, `add -A` never drops an entry
	// because of a LATER ignore rule (git ignores don't apply to tracked
	// paths). cp0 lacks the file → restore cp0 deleted the now-ignored file
	// from disk. The sync must evict shadow-tracked-but-now-ignored paths
	// (unless the REAL repo tracks them) before read-tree.
	const cp0 = await createCheckpoint(opts("entry-0"));

	await writeFile(join(repo, "secret.env"), "v1\n");
	const cp1 = await createCheckpoint(opts("entry-1"));
	// prove the state transition under test: the shadow DID track it
	const cp1Files = await git(
		["--git-dir", shadow.gitDir, "ls-tree", "-r", "--name-only", cp1.worktreeTreeSha],
		repo,
	);
	expect(cp1Files).toContain("secret.env");

	// ignore source OUTSIDE snapshot scope (worktree .gitignore would itself
	// be reverted by the restore); content edited after being ignored
	await writeFile(join(repo, ".git", "info", "exclude"), "secret.env\n");
	await writeFile(join(repo, "secret.env"), "TOKEN=current\n");
	// dirty a tracked file so the restore provably did work
	await writeFile(join(repo, "a.txt"), "dirty\n");

	await restoreCheckpoint(shadow, cp0);
	expect(await readFile(join(repo, "secret.env"), "utf-8")).toBe(
		"TOKEN=current\n",
	);
	// the SAME restore really reverted tracked content (not a no-op)
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("original\n");

	// and it left the snapshot set: the next checkpoint excludes it
	const cp2 = await createCheckpoint(opts("entry-2"));
	const files = await git(
		["--git-dir", shadow.gitDir, "ls-tree", "-r", "--name-only", cp2.worktreeTreeSha],
		repo,
	);
	expect(files).not.toContain("secret.env");
});

test("restore never overwrites a currently-ignored file captured by the target checkpoint", async () => {
	// cp1 captured secret.env=v1 while it was snapshot-scoped. Later the
	// user ignores it and edits it. Restoring cp1 must NOT clobber the
	// current content with v1: currently-ignored paths are outside rewind's
	// jurisdiction in BOTH directions (never deleted, never written).
	await writeFile(join(repo, "secret.env"), "v1\n");
	const cp1 = await createCheckpoint(opts("entry-1"));
	const cp1Files = await git(
		["--git-dir", shadow.gitDir, "ls-tree", "-r", "--name-only", cp1.worktreeTreeSha],
		repo,
	);
	expect(cp1Files).toContain("secret.env");

	await writeFile(join(repo, ".git", "info", "exclude"), "secret.env\n");
	await writeFile(join(repo, "secret.env"), "TOKEN=current\n");
	await writeFile(join(repo, "a.txt"), "dirty\n");

	await restoreCheckpoint(shadow, cp1);
	// tracked content restored — the restore did real work
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("original\n");
	// ignored content NOT rolled back to v1
	expect(await readFile(join(repo, "secret.env"), "utf-8")).toBe(
		"TOKEN=current\n",
	);
});

test("restore never re-stages a currently-ignored path via the staged patch", async () => {
	// cp1 had secret.env STAGED (add -f). Later: unstaged, ignored, edited.
	// restore(cp1) strips it from the worktree tree, but read-tree HEAD +
	// apply --cached replays the old staged patch — re-inserting it into the
	// REAL index; the next sync's ls-files then treats it as tracked+ignored
	// and force-adds it back into snapshots. Protection defeated.
	await writeFile(join(repo, "a.txt"), "staged\n");
	await git(["add", "a.txt"], repo);
	await writeFile(join(repo, "secret.env"), "v1\n");
	await git(["add", "-f", "secret.env"], repo);
	const cp1 = await createCheckpoint(opts("entry-1"));
	expect(cp1.stagedPatchBlob).not.toBeNull();

	await git(["reset", "HEAD", "--", "secret.env"], repo);
	await writeFile(join(repo, ".git", "info", "exclude"), "secret.env\n");
	await writeFile(join(repo, "secret.env"), "TOKEN=current\n");
	await writeFile(join(repo, "a.txt"), "dirty\n");

	const result = await restoreCheckpoint(shadow, cp1);
	// worktree: ignored content untouched, tracked content restored
	expect(await readFile(join(repo, "secret.env"), "utf-8")).toBe(
		"TOKEN=current\n",
	);
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("staged\n");
	// staged split restored for legit paths…
	expect(result.stagedRestored).toBe(true);
	const staged = await git(["diff", "--cached", "--name-only"], repo);
	expect(staged).toContain("a.txt");
	// …but the ignored path must NOT be back in the real index
	const inIndex = await git(
		["ls-files", "--error-unmatch", "secret.env"],
		repo,
	).then(
		() => true,
		() => false,
	);
	expect(inIndex).toBe(false);
});

test("read-tree HEAD alone cannot re-insert an ignored path (no staged patch)", async () => {
	// secret.env is committed, cp1 taken CLEAN (stagedPatchBlob null). User
	// then evicts it (`git rm --cached`), ignores it, edits it. restore(cp1):
	// read-tree HEAD re-inserts it into the real index with NO apply step
	// involved — the strip must still remove it (user's latest intent,
	// rm --cached + ignore, outranks checkpoint index fidelity).
	await writeFile(join(repo, "secret.env"), "v1\n");
	await git(["add", "-f", "secret.env"], repo);
	await git(["commit", "-m", "add secret"], repo);
	const cp1 = await createCheckpoint(opts("entry-1"));
	expect(cp1.stagedPatchBlob).toBeNull();

	await git(["rm", "--cached", "secret.env"], repo); // NOT committed: HEAD still has it
	await writeFile(join(repo, ".git", "info", "exclude"), "secret.env\n");
	await writeFile(join(repo, "secret.env"), "TOKEN=current\n");

	await restoreCheckpoint(shadow, cp1);
	expect(await readFile(join(repo, "secret.env"), "utf-8")).toBe(
		"TOKEN=current\n",
	);
	const inIndex = await git(
		["ls-files", "--error-unmatch", "secret.env"],
		repo,
	).then(
		() => true,
		() => false,
	);
	expect(inIndex).toBe(false);
});

test("cleanup covers ignored paths re-inserted by read-tree HEAD that the target tree LACKS", async () => {
	// Counter-example to target-tree-derived cleanup: HEAD commits secret →
	// worktree deletion NOT staged → cp tree lacks it (strip would be empty)
	// → user evicts (rm --cached), recreates, ignores → restore. read-tree
	// HEAD re-tracks it; the cleanup set must come from the LIVE index, not
	// from the target tree.
	await writeFile(join(repo, "secret.env"), "v1\n");
	await git(["add", "-f", "secret.env"], repo);
	await git(["commit", "-m", "add secret"], repo);
	await rm(join(repo, "secret.env")); // worktree deletion, NOT staged
	const cp = await createCheckpoint(opts("entry-1"));
	const cpFiles = await git(
		["--git-dir", shadow.gitDir, "ls-tree", "-r", "--name-only", cp.worktreeTreeSha],
		repo,
	);
	expect(cpFiles).not.toContain("secret.env"); // premise: target tree lacks it
	expect(cp.stagedPatchBlob).toBeNull(); // premise: no staged patch involved

	await git(["rm", "--cached", "secret.env"], repo); // evict; HEAD still has it
	await writeFile(join(repo, "secret.env"), "TOKEN=current\n"); // recreate
	await writeFile(join(repo, ".git", "info", "exclude"), "secret.env\n");

	await restoreCheckpoint(shadow, cp);
	expect(await readFile(join(repo, "secret.env"), "utf-8")).toBe(
		"TOKEN=current\n",
	);
	const inIndex = await git(
		["ls-files", "--error-unmatch", "secret.env"],
		repo,
	).then(
		() => true,
		() => false,
	);
	expect(inIndex).toBe(false);
});

test("folder mode: nested repos block file restore instead of half-restoring", async () => {
	// `add -A` records embedded repos as gitlinks: their content is in
	// NEITHER the checkpoint nor the synced index. A "successful" restore
	// would silently skip everything inside them — so restore is BLOCKED
	// (RestoreBlockedError, dialog offers conversation-only) rather than
	// claiming coverage it does not have. Each nested repo is its own
	// rewind domain: run omp inside it.
	const dir = await initFolder();
	try {
		await writeFile(join(dir, "root.txt"), "r1\n");
		const child = join(dir, "child");
		await mkdir(child);
		await git(["init", "-b", "main"], child);
		await git(["config", "user.email", "t@t"], child);
		await git(["config", "user.name", "t"], child);
		await writeFile(join(child, "inner.txt"), "committed\n");
		await git(["add", "."], child);
		await git(["commit", "-m", "c"], child);
		await writeFile(join(child, "inner.txt"), "edited-at-cp\n");

		const fShadow = await openShadow(dir, SESSION, { cacheRoot, noRepo: true });
		const cp = await createCheckpoint(folderOpts(fShadow, "e1"));
		expect(await listGitlinks(fShadow)).toEqual(["child"]);

		await writeFile(join(child, "inner.txt"), "edited-later\n");
		await writeFile(join(dir, "root.txt"), "r2\n");

		await expect(restoreCheckpoint(fShadow, cp)).rejects.toThrow(
			RestoreBlockedError,
		);
		// nothing was half-restored: root untouched, child untouched
		expect(await readFile(join(dir, "root.txt"), "utf-8")).toBe("r2\n");
		expect(await readFile(join(child, "inner.txt"), "utf-8")).toBe(
			"edited-later\n",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("listGitlinks is empty for plain folders and plain repos", async () => {
	expect(await listGitlinks(shadow)).toEqual([]);
	const dir = await initFolder();
	try {
		await writeFile(join(dir, "a.txt"), "x\n");
		const fShadow = await openShadow(dir, SESSION, { cacheRoot, noRepo: true });
		await createCheckpoint(folderOpts(fShadow, "e1"));
		expect(await listGitlinks(fShadow)).toEqual([]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("restore is blocked when the TARGET tree contains gitlinks (child since removed)", async () => {
	// Guarding only the current index is not enough. Same-session the stale
	// gitlink usually survives in the persistent index, but a FRESH index
	// (prune-all drops index files; /new rebinds to a new one) rebuilt from
	// a workspace where the child repo was replaced by a PLAIN directory has
	// no gitlink → old guard passed → read-tree applied the gitlink tree:
	// replacement content (in synced index, absent from target) got DELETED
	// and the gitlink landed as an empty dir. Block on current ∪ target.
	const dir = await initFolder();
	try {
		await writeFile(join(dir, "root.txt"), "r1\n");
		const child = join(dir, "child");
		await mkdir(child);
		await git(["init", "-b", "main"], child);
		await git(["config", "user.email", "t@t"], child);
		await git(["config", "user.name", "t"], child);
		await writeFile(join(child, "inner.txt"), "committed\n");
		await git(["add", "."], child);
		await git(["commit", "-m", "c"], child);

		const fShadow = await openShadow(dir, SESSION, { cacheRoot, noRepo: true });
		const cp = await createCheckpoint(folderOpts(fShadow, "e1")); // tree has gitlink

		// child repo replaced by a plain directory with precious content
		await rm(child, { recursive: true, force: true });
		await mkdir(child);
		await writeFile(join(child, "replacement.txt"), "precious\n");
		await writeFile(join(dir, "root.txt"), "r2\n");

		// fresh per-session index (as after prune-all or /new): no gitlink in it
		const s2 = await openShadow(dir, "session-2", { cacheRoot, noRepo: true });
		const cpLoaded = await loadCheckpoint(fShadow, SESSION, "e1");
		if (!cpLoaded) throw new Error("checkpoint lost");

		await expect(restoreCheckpoint(s2, cpLoaded)).rejects.toThrow(
			RestoreBlockedError,
		);
		// refused BEFORE any root change: nothing was touched
		expect(await readFile(join(dir, "root.txt"), "utf-8")).toBe("r2\n");
		expect(await readFile(join(child, "replacement.txt"), "utf-8")).toBe(
			"precious\n",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("repo mode: untracked embedded repo blocks restore (not a submodule)", async () => {
	// Same hole as folder mode: an embedded repo the REAL repo does NOT
	// track (no 160000 entry — not a submodule) is still recorded as a
	// shadow gitlink. cp captured it; child later replaced by a plain dir;
	// FRESH shadow index sees no gitlink → old guard (noRepo-only) never
	// ran in repo mode → read-tree applied the gitlink tree and deleted the
	// replacement contents.
	const child = join(repo, "child");
	await mkdir(child);
	await git(["init", "-b", "main"], child);
	await git(["config", "user.email", "t@t"], child);
	await git(["config", "user.name", "t"], child);
	await writeFile(join(child, "inner.txt"), "committed\n");
	await git(["add", "."], child);
	await git(["commit", "-m", "c"], child);

	const cp = await createCheckpoint(opts("entry-1")); // shadow tree: gitlink

	await rm(child, { recursive: true, force: true });
	await mkdir(child);
	await writeFile(join(child, "replacement.txt"), "precious\n");
	await writeFile(join(repo, "a.txt"), "dirty\n");

	const s2 = await openShadow(repo, "session-2", { cacheRoot }); // fresh index
	const cpLoaded = await loadCheckpoint(s2, SESSION, "entry-1");
	if (!cpLoaded) throw new Error("checkpoint lost");
	await expect(restoreCheckpoint(s2, cpLoaded)).rejects.toThrow(
		RestoreBlockedError,
	);
	// refused before any change
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("dirty\n");
	expect(await readFile(join(child, "replacement.txt"), "utf-8")).toBe(
		"precious\n",
	);
});

test("repo mode: a REAL submodule (tracked 160000) does not block restore", async () => {
	// Legitimate submodules keep git-native pointer semantics — only
	// embedded repos the real repo does NOT track should block. The nested
	// repo stays ON DISK so the shadow's add -A actually records the
	// gitlink (deleting it first would make this test vacuously green).
	const child = join(repo, "child");
	await mkdir(child);
	await git(["init", "-b", "main"], child);
	await git(["config", "user.email", "t@t"], child);
	await git(["config", "user.name", "t"], child);
	await writeFile(join(child, "inner.txt"), "x\n");
	await git(["add", "."], child);
	await git(["commit", "-m", "c"], child);
	const childSha = await git(["rev-parse", "HEAD"], child);
	// track it as a gitlink in the REAL repo (submodule without .gitmodules)
	await git(
		["update-index", "--add", "--cacheinfo", `160000,${childSha},child`],
		repo,
	);
	await git(["commit", "-m", "add submodule pointer"], repo);

	const cp = await createCheckpoint(opts("entry-1"));
	// premise: the checkpoint tree REALLY contains the gitlink
	expect(await listTreeGitlinks(shadow, cp.worktreeTreeSha)).toEqual([
		"child",
	]);

	await writeFile(join(repo, "a.txt"), "dirty\n");
	await writeFile(join(child, "inner.txt"), "child-edit\n");
	const result = await restoreCheckpoint(shadow, cp);
	expect(result.stagedRestored).toBe(true);
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("original\n");
	// submodule content keeps git-native semantics: restore never enters it
	expect(await readFile(join(child, "inner.txt"), "utf-8")).toBe(
		"child-edit\n",
	);
});

test("prune keep N keeps the newest N of the current session only", async () => {
	// sequential creates differ by milliseconds — createdAt (ms ISO in the
	// commit message) orders them; committerdate (seconds) would tie.
	await createCheckpoint(opts("entry-1"));
	await writeFile(join(repo, "a.txt"), "v2\n");
	await createCheckpoint(opts("entry-2"));
	await writeFile(join(repo, "a.txt"), "v3\n");
	await createCheckpoint(opts("entry-3"));
	await createCheckpoint({
		shadow,
		sessionId: "other-session",
		entryId: "e9",
	});

	const result = await pruneCheckpoints(shadow, { keep: 1 }, SESSION);
	expect(result.deleted).toBe(2);
	expect(result.failed).toBe(0);

	const refs = (await listCheckpointRefs(shadow)).map((l) => l.ref).sort();
	// newest of OUR session survives; other session untouched
	expect(refs).toEqual(
		[
			checkpointRef(SESSION, "entry-3"),
			checkpointRef("other-session", "e9"),
		].sort(),
	);

	// keep more than exist → no-op
	const noop = await pruneCheckpoints(shadow, { keep: 99 }, SESSION);
	expect(noop.deleted).toBe(0);
});

test("prune keep N never deletes refs with unreadable metadata (fail-closed)", async () => {
	const cp1 = await createCheckpoint(opts("entry-1"));
	await writeFile(join(repo, "a.txt"), "v2\n");
	await createCheckpoint(opts("entry-2"));
	// forge a same-session ref whose commit has NO CheckpointMeta JSON
	const bare = await git(
		["--git-dir", shadow.gitDir, "commit-tree", cp1.worktreeTreeSha, "-m", "no meta"],
		repo,
	);
	await git(
		["--git-dir", shadow.gitDir, "update-ref", checkpointRef(SESSION, "forged"), bare],
		repo,
	);

	const result = await pruneCheckpoints(shadow, { keep: 1 }, SESSION);
	// only the ORDERABLE older ref goes; the unknown-age ref survives even
	// though survivors now exceed N
	expect(result.deleted).toBe(1);
	const refs = (await listCheckpointRefs(shadow)).map((l) => l.ref).sort();
	expect(refs).toEqual(
		[
			checkpointRef(SESSION, "entry-2"),
			checkpointRef(SESSION, "forged"),
		].sort(),
	);
});
