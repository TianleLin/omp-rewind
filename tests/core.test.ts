/**
 * omp-rewind core tests — exercise the real git contract:
 * snapshot fidelity, HEAD immutability, untracked safety, staged-state
 * roundtrip, cross-branch blocking, ref hygiene, pruning — and the shadow
 * invariant: the workspace's own .git gains no refs and no objects.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkpointRef,
	createCheckpoint,
	diffTreeStat,
	git,
	listCheckpointRefs,
	loadCheckpoint,
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
	shadow = await openShadow(repo, SESSION, cacheRoot);
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

	expect(restoreCheckpoint(shadow, cp)).rejects.toThrow(RestoreBlockedError);
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
		const unbornShadow = await openShadow(root, "s", cacheRoot);
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
	const again = await openShadow(repo, "another-session", cacheRoot);
	expect(again.gitDir).toBe(shadow.gitDir);
	expect(again.indexFile).not.toBe(shadow.indexFile);
});


// ============================================================================
// git() runner + pathspec boundary contracts
// ============================================================================
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
