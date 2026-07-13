/**
 * omp-rewind core tests — exercise the real git contract:
 * snapshot fidelity, HEAD immutability, untracked safety, staged-state
 * roundtrip, cross-branch blocking, ref hygiene, and pruning.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkpointRef,
	createCheckpoint,
	currentWorktreeTree,
	diffTreeStat,
	git,
	listCheckpointRefs,
	loadCheckpoint,
	pruneCheckpoints,
	refComponent,
	RestoreBlockedError,
	restoreCheckpoint,
} from "../src/core.ts";

let repo: string;

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

beforeEach(async () => {
	repo = await initRepo();
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

const opts = (entryId: string) => ({
	root: repo,
	sessionId: "11111111-2222-3333-4444-555555555555",
	entryId,
});

test("checkpoint → load roundtrips metadata", async () => {
	const cp = await createCheckpoint({ ...opts("entry-1"), label: "turn-start" });
	const loaded = await loadCheckpoint(repo, cp.sessionId, "entry-1");
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
	await restoreCheckpoint(repo, cp);

	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("original\n");
	expect(stat(join(repo, "new-file.txt"))).rejects.toThrow();
});

test("restore resurrects files deleted after the checkpoint", async () => {
	await writeFile(join(repo, "doomed.txt"), "keep me\n");
	const cp = await createCheckpoint(opts("entry-1"));

	await rm(join(repo, "doomed.txt"));
	await restoreCheckpoint(repo, cp);

	expect(await readFile(join(repo, "doomed.txt"), "utf-8")).toBe("keep me\n");
});

test("restore preserves untracked files that existed at checkpoint time", async () => {
	await writeFile(join(repo, "preexisting.txt"), "before checkpoint\n");
	const cp = await createCheckpoint(opts("entry-1"));

	await writeFile(join(repo, "preexisting.txt"), "modified later\n");
	await restoreCheckpoint(repo, cp);

	// Content comes back from the snapshot (full-workspace scope) …
	expect(await readFile(join(repo, "preexisting.txt"), "utf-8")).toBe(
		"before checkpoint\n",
	);
	// … and it is still untracked, not silently staged.
	const status = await git(["status", "--porcelain", "preexisting.txt"], repo);
	expect(status.startsWith("??")).toBe(true);
});

test("restore never deletes gitignored files", async () => {
	await writeFile(join(repo, ".gitignore"), "secret.env\n");
	await git(["add", ".gitignore"], repo);
	await git(["commit", "-m", "ignore"], repo);
	const cp = await createCheckpoint(opts("entry-1"));

	await writeFile(join(repo, "secret.env"), "TOKEN=x\n");
	await restoreCheckpoint(repo, cp);

	expect(await readFile(join(repo, "secret.env"), "utf-8")).toBe("TOKEN=x\n");
});

test("restore keeps HEAD and later commits intact (files-only contract)", async () => {
	const cp = await createCheckpoint(opts("entry-1"));

	await writeFile(join(repo, "a.txt"), "committed change\n");
	await git(["add", "a.txt"], repo);
	await git(["commit", "-m", "later commit"], repo);
	const headAfterCommit = await git(["rev-parse", "HEAD"], repo);

	await restoreCheckpoint(repo, cp);

	// HEAD unchanged — commit B survives on the branch.
	expect(await git(["rev-parse", "HEAD"], repo)).toBe(headAfterCommit);
	// Working tree matches the checkpoint, shown as uncommitted changes.
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("original\n");
	const status = await git(["status", "--porcelain"], repo);
	expect(status).toContain("a.txt");
});

test("restore reproduces the staged/unstaged split", async () => {
	await writeFile(join(repo, "a.txt"), "staged content\n");
	await git(["add", "a.txt"], repo);
	await writeFile(join(repo, "a.txt"), "unstaged on top\n");
	const cp = await createCheckpoint(opts("entry-1"));

	await git(["reset", "--hard", "HEAD"], repo);
	await restoreCheckpoint(repo, cp);

	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("unstaged on top\n");
	const staged = await git(["diff", "--cached", "--name-only"], repo);
	expect(staged).toContain("a.txt");
	const unstaged = await git(["diff", "--name-only"], repo);
	expect(unstaged).toContain("a.txt");
});

test("cross-branch restore is blocked", async () => {
	const cp = await createCheckpoint(opts("entry-1"));
	await git(["checkout", "-b", "feature"], repo);

	expect(restoreCheckpoint(repo, cp)).rejects.toThrow(RestoreBlockedError);
	// and the worktree was not touched
	expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("original\n");
});

test("checkpoint in subdirectory-rich repo captures nested untracked files", async () => {
	await mkdir(join(repo, "deep/nested"), { recursive: true });
	await writeFile(join(repo, "deep/nested/file.txt"), "nested\n");
	const cp = await createCheckpoint(opts("entry-1"));

	await rm(join(repo, "deep"), { recursive: true });
	await restoreCheckpoint(repo, cp);

	expect(await readFile(join(repo, "deep/nested/file.txt"), "utf-8")).toBe(
		"nested\n",
	);
});

test("refComponent sanitizes hostile ids and keeps refs valid", async () => {
	expect(refComponent("a/b:c d*e")).toBe("a_b_c_d_e");
	expect(refComponent(".hidden")).toBe("_hidden");
	expect(refComponent("x.lock")).toBe("x_lock");
	expect(refComponent("")).toBe("_");

	// A hostile entry ID still produces a usable ref.
	const cp = await createCheckpoint({
		root: repo,
		sessionId: "s p a c e",
		entryId: "we/ird~id",
	});
	expect(cp.entryId).toBe("we/ird~id");
	const loaded = await loadCheckpoint(repo, "s p a c e", "we/ird~id");
	expect(loaded).not.toBeNull();
});

test("second checkpoint on the same entry overwrites the ref", async () => {
	await createCheckpoint(opts("entry-1"));
	await writeFile(join(repo, "a.txt"), "v2\n");
	await createCheckpoint(opts("entry-1"));

	const refs = await listCheckpointRefs(repo);
	expect(refs.length).toBe(1);
	const loaded = await loadCheckpoint(
		repo,
		opts("entry-1").sessionId,
		"entry-1",
	);
	// latest content wins
	const restoredTree = loaded!.worktreeTreeSha;
	expect(restoredTree).toBe(await currentWorktreeTree(repo));
});

test("prune others keeps current session, prune all wipes", async () => {
	await createCheckpoint(opts("entry-1"));
	await createCheckpoint({
		root: repo,
		sessionId: "other-session",
		entryId: "entry-9",
	});

	const deletedOthers = await pruneCheckpoints(
		repo,
		"others",
		opts("x").sessionId,
	);
	expect(deletedOthers).toBe(1);
	let refs = await listCheckpointRefs(repo);
	expect(refs.length).toBe(1);
	expect(refs[0]!.ref).toBe(checkpointRef(opts("x").sessionId, "entry-1"));

	const deletedAll = await pruneCheckpoints(repo, "all", opts("x").sessionId);
	expect(deletedAll).toBe(1);
	refs = await listCheckpointRefs(repo);
	expect(refs.length).toBe(0);
});

test("diffTreeStat is empty for identical trees and non-empty for changes", async () => {
	const cp1 = await createCheckpoint(opts("entry-1"));
	expect(await diffTreeStat(repo, cp1.worktreeTreeSha, cp1.worktreeTreeSha)).toBe(
		"",
	);

	await writeFile(join(repo, "a.txt"), "changed\n");
	const cp2 = await createCheckpoint(opts("entry-2"));
	const stat2 = await diffTreeStat(
		repo,
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
		await writeFile(join(root, "first.txt"), "hello\n");

		const cp = await createCheckpoint({
			root,
			sessionId: "s",
			entryId: "e",
		});
		await writeFile(join(root, "first.txt"), "mutated\n");
		await restoreCheckpoint(root, cp);
		expect(await readFile(join(root, "first.txt"), "utf-8")).toBe("hello\n");
	} finally {
		await rm(bare, { recursive: true, force: true });
	}
});
