/**
 * Host-simulation e2e — drives the REAL extension entry (src/index.ts
 * default export) through the same event sequence OMP emits, against a
 * REAL git repo and REAL shadow store. Only the host surface (PiApiLike,
 * UI, SessionManager) is faked, via the same structural types OMP uses.
 *
 * What this proves that core.test.ts cannot: checkpoint scheduling,
 * dialog wording/ordering, cancel/conversation-only/force paths, presence
 * gating, folder-mode wiring, and the subagent claim — the full loop from
 * event to disk.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index.ts";
import { git } from "../src/core.ts";
import type { PresenceRecord } from "../src/presence.ts";
import type {
	BeforeTreeResult,
	ExtensionContextLike,
	PiApiLike,
	SessionEntryLike,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fake host
// ---------------------------------------------------------------------------

type Handler = (
	event: unknown,
	ctx: ExtensionContextLike,
) => unknown | Promise<unknown>;

type CommandHandler = (
	args: string,
	ctx: ExtensionContextLike,
) => Promise<void> | void;

class FakeHost {
	handlers = new Map<string, Handler[]>();
	commands = new Map<string, CommandHandler>();
	pi: PiApiLike = {
		on: (event, handler) => {
			const list = this.handlers.get(event) ?? [];
			list.push(handler as Handler);
			this.handlers.set(event, list);
		},
		registerCommand: (name, command) => {
			this.commands.set(name, command.handler);
		},
		logger: { warn: () => {} },
	};

	async runCommand(
		name: string,
		args: string,
		ctx: ExtensionContextLike,
	): Promise<void> {
		const handler = this.commands.get(name);
		if (!handler) throw new Error(`command not registered: ${name}`);
		await handler(args, ctx);
	}

	/** Emit like OMP: run handlers in order, return the last defined result. */
	async emit(
		event: string,
		payload: unknown,
		ctx: ExtensionContextLike,
	): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			const value = await handler(payload, ctx);
			if (value !== undefined) result = value;
		}
		return result;
	}
}

class FakeUI {
	answers: string[] = [];
	selects: { title: string; options: string[] }[] = [];
	notices: { message: string; level: string }[] = [];
	status = new Map<string, string | undefined>();

	notify(message: string, level: "info" | "warning" | "error"): void {
		this.notices.push({ message, level });
	}
	async select(title: string, options: string[]): Promise<string | undefined> {
		this.selects.push({ title, options });
		const answer = this.answers.shift();
		return answer !== undefined && options.includes(answer)
			? answer
			: undefined;
	}
	setStatus(key: string, text: string | undefined): void {
		this.status.set(key, text);
	}
}

class FakeSessionManager {
	entries: SessionEntryLike[] = [];
	leafId: string | null = null;
	private seq = 0;

	constructor(public sessionId: string) {}

	getSessionId(): string {
		return this.sessionId;
	}
	getEntries(): SessionEntryLike[] {
		return this.entries;
	}
	getEntry(id: string): SessionEntryLike | undefined {
		return this.entries.find((entry) => entry.id === id);
	}
	/** Root→leaf chain ending at fromId (OMP's getBranch contract). */
	getBranch(fromId?: string): SessionEntryLike[] {
		const chain: SessionEntryLike[] = [];
		let cursor: string | null = fromId ?? this.leafId;
		while (cursor !== null) {
			const entry = this.getEntry(cursor);
			if (!entry) break;
			chain.push(entry);
			cursor = entry.parentId;
		}
		return chain.reverse();
	}
	add(type: string, role?: string): SessionEntryLike {
		const entry: SessionEntryLike = {
			id: `e${++this.seq}`,
			parentId: this.leafId,
			type,
			role,
		};
		this.entries.push(entry);
		this.leafId = entry.id;
		return entry;
	}
}

// ---------------------------------------------------------------------------
// Scenario scaffolding
// ---------------------------------------------------------------------------

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CLAIM = Symbol.for("omp-rewind.main-claim");

let workspace: string;
let host: FakeHost;
let ui: FakeUI;
let sm: FakeSessionManager;
let ctx: ExtensionContextLike;

const shadowDirFor = (root: string) =>
	join(
		homedir(),
		".omp",
		"agent",
		"cache",
		"omp-rewind",
		createHash("sha256").update(root).digest("hex").slice(0, 16),
	);

async function bootHost(root: string): Promise<void> {
	// process-global claim from a previous test instance must not leak in
	const registry = globalThis as Record<PropertyKey, unknown>;
	registry[CLAIM] = undefined;
	host = new FakeHost();
	ui = new FakeUI();
	sm = new FakeSessionManager(SESSION);
	ctx = {
		cwd: root,
		hasUI: true,
		ui,
		sessionManager: sm,
		isIdle: () => true,
	};
	extension(host.pi);
	await host.emit("session_start", {}, ctx);
}

async function initRepoWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "omp-rewind-sim-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "sim@test"], dir);
	await git(["config", "user.name", "sim"], dir);
	await writeFile(join(dir, "a.txt"), "v0\n");
	await git(["add", "."], dir);
	await git(["commit", "-m", "init"], dir);
	return git(["rev-parse", "--show-toplevel"], dir);
}

/** One agent turn: user entry, turn-start checkpoint, mutation, tool end. */
async function runTurn(mutate: () => Promise<void>): Promise<SessionEntryLike> {
	sm.add("message", "user");
	await host.emit("before_agent_start", {}, ctx);
	await host.emit("agent_start", {}, ctx);
	await mutate();
	const toolEntry = sm.add("message", "toolResult");
	await host.emit("tool_execution_end", { toolName: "bash" }, ctx);
	sm.add("message", "assistant");
	await host.emit("agent_end", {}, ctx);
	return toolEntry;
}

/** Navigate to target and answer the dialog; returns the before_tree result. */
async function navigate(
	targetId: string,
	answer: string,
): Promise<BeforeTreeResult | undefined> {
	ui.answers.push(answer);
	const result = (await host.emit(
		"session_before_tree",
		{ targetId, oldLeafId: sm.leafId },
		ctx,
	)) as BeforeTreeResult | undefined;
	if (result?.cancel) return result;
	// OMP applies the move, then emits session_tree with the new leaf.
	const entry = sm.getEntry(targetId);
	const newLeaf =
		entry && entry.type === "message" && entry.role === "user"
			? entry.parentId
			: targetId;
	sm.leafId = newLeaf;
	await host.emit("session_tree", { newLeafId: newLeaf }, ctx);
	return result;
}

afterEach(async () => {
	await host.emit("session_shutdown", {}, ctx);
	await rm(shadowDirFor(workspace), { recursive: true, force: true });
	await rm(workspace, { recursive: true, force: true });
	const registry = globalThis as Record<PropertyKey, unknown>;
	registry[CLAIM] = undefined;
});

// ---------------------------------------------------------------------------
// Repo-mode flows
// ---------------------------------------------------------------------------

beforeEach(async () => {
	workspace = await initRepoWorkspace();
	await bootHost(workspace);
});

test("full loop: two turns, navigate back, files restored on disk", async () => {
	const turn1 = await runTurn(() =>
		writeFile(join(workspace, "a.txt"), "v1\n"),
	);
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v2\n"));
	expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("v2\n");

	const result = await navigate(turn1.id, "Restore conversation + files");
	expect(result?.cancel).toBeUndefined();
	expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("v1\n");
	// dialog carried a real diff stat and the standard options
	const dialog = ui.selects.at(-1);
	expect(dialog?.title).toContain("a.txt");
	expect(dialog?.options).toEqual([
		"Restore conversation + files",
		"Restore conversation only",
		"Cancel",
	]);
	expect(ui.notices.at(-1)?.message).toBe("Files restored to checkpoint.");
});

test("navigating to a user entry restores its parent's checkpoint", async () => {
	await runTurn(() => writeFile(join(workspace, "b.txt"), "turn1\n"));
	const user2 = sm.add("message", "user");
	await host.emit("before_agent_start", {}, ctx);
	await writeFile(join(workspace, "b.txt"), "turn2\n");
	sm.add("message", "toolResult");
	await host.emit("tool_execution_end", { toolName: "edit" }, ctx);

	// user entry → effective leaf is its parent (end of turn 1)
	await navigate(user2.id, "Restore conversation + files");
	expect(await readFile(join(workspace, "b.txt"), "utf-8")).toBe("turn1\n");
});

test("cancel and conversation-only both leave files untouched", async () => {
	const turn1 = await runTurn(() =>
		writeFile(join(workspace, "a.txt"), "v1\n"),
	);
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v2\n"));

	const cancelled = await navigate(turn1.id, "Cancel");
	expect(cancelled?.cancel).toBe(true);
	expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("v2\n");

	await navigate(turn1.id, "Restore conversation only");
	expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("v2\n");
});

test("read-only tools create no checkpoint refs", async () => {
	sm.add("message", "user");
	await host.emit("before_agent_start", {}, ctx); // 1 ref (turn-start)
	sm.add("message", "toolResult");
	await host.emit("tool_execution_end", { toolName: "read" }, ctx);
	sm.add("message", "toolResult");
	await host.emit("tool_execution_end", { toolName: "grep" }, ctx);

	const refs = await git(
		["--git-dir", shadowDirFor(workspace), "for-each-ref", "refs/omp-rewind/"],
		workspace,
	);
	expect(refs.split("\n").filter(Boolean)).toHaveLength(1);
});

test("busy peer: blocked ordering, cancel default, force works", async () => {
	const turn1 = await runTurn(() =>
		writeFile(join(workspace, "a.txt"), "v1\n"),
	);
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v2\n"));

	// Forge a live busy peer (ppid) — as another omp process would.
	const shadowDir = shadowDirFor(workspace);
	const record: PresenceRecord = {
		pid: process.ppid,
		sessionId: "peer",
		busy: true,
		updatedAt: new Date().toISOString(),
	};
	await mkdir(join(shadowDir, "presence"), { recursive: true });
	await writeFile(
		join(shadowDir, "presence", `${process.ppid}.json`),
		JSON.stringify(record),
	);

	// Blocked: options reordered, file restore labeled unsafe, ⛔ in body.
	const blocked = await navigate(turn1.id, "Cancel");
	expect(blocked?.cancel).toBe(true);
	const dialog = ui.selects.at(-1);
	expect(dialog?.title).toContain("⛔");
	expect(dialog?.title).toContain(`pid ${process.ppid}`);
	expect(dialog?.options).toEqual([
		"Cancel",
		"Restore conversation only",
		"Force restore files anyway (unsafe)",
	]);
	expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("v2\n");

	// Force: restore proceeds despite the peer.
	await navigate(turn1.id, "Force restore files anyway (unsafe)");
	expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("v1\n");
});

test("presence lifecycle tracks the agent loop and shutdown", async () => {
	const presenceFile = join(
		shadowDirFor(workspace),
		"presence",
		`${process.pid}.json`,
	);
	const readBusy = async () => {
		const record = JSON.parse(
			await readFile(presenceFile, "utf-8"),
		) as PresenceRecord;
		return record.busy;
	};

	expect(await readBusy()).toBe(false); // after session_start
	await host.emit("agent_start", {}, ctx);
	expect(await readBusy()).toBe(true);
	await host.emit("agent_end", {}, ctx);
	expect(await readBusy()).toBe(false);
	await host.emit("session_shutdown", {}, ctx);
	await expect(stat(presenceFile)).rejects.toThrow();
});

test("second same-process instance without UI stays inert (subagent claim)", async () => {
	const child = new FakeHost();
	const childSm = new FakeSessionManager("child-session");
	const childCtx: ExtensionContextLike = {
		...ctx,
		hasUI: false,
		ui: new FakeUI(),
		sessionManager: childSm,
	};
	extension(child.pi);
	await child.emit("session_start", {}, childCtx);

	childSm.add("message", "user");
	await child.emit("before_agent_start", {}, childCtx);
	childSm.add("message", "toolResult");
	await child.emit("tool_execution_end", { toolName: "bash" }, childCtx);

	const refs = await git(
		["--git-dir", shadowDirFor(workspace), "for-each-ref", "refs/omp-rewind/"],
		workspace,
	).catch(() => "");
	expect(refs).not.toContain("child-session");
});

test("git missing: disabled with a warning notice", async () => {
	const savedPath = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try {
		workspace = await realpath(await mkdtemp(join(tmpdir(), "omp-rewind-nogit-")));
		await bootHost(workspace);
		expect(
			ui.notices.some(
				(n) => n.level === "warning" && n.message.includes("git is not installed"),
			),
		).toBe(true);
		expect(ui.status.get("omp-rewind")).toBeUndefined();
	} finally {
		process.env.PATH = savedPath;
	}
});

test("folder mode: status suffix and full restore loop without a repo", async () => {
	workspace = await realpath(await mkdtemp(join(tmpdir(), "omp-rewind-plain-")));
	await bootHost(workspace);
	expect(ui.status.get("omp-rewind")).toContain("(folder)");

	await writeFile(join(workspace, "notes.md"), "draft 1\n");
	const turn1 = await runTurn(() =>
		writeFile(join(workspace, "notes.md"), "draft 2\n"),
	);
	await runTurn(async () => {
		await writeFile(join(workspace, "notes.md"), "draft 3\n");
		await writeFile(join(workspace, "junk.tmp"), "x\n");
	});

	await navigate(turn1.id, "Restore conversation + files");
	expect(await readFile(join(workspace, "notes.md"), "utf-8")).toBe(
		"draft 2\n",
	);
	await expect(stat(join(workspace, "junk.tmp"))).rejects.toThrow();
	await expect(stat(join(workspace, ".git"))).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// Regressions: turn-start binding (BUG: bound to the user entry itself,
// which the ancestor chain of its parent can never reach)
// ---------------------------------------------------------------------------

test("rewind to the FIRST user message restores pre-session file state", async () => {
	// Before the fix: turn-start cp was bound to user1 itself; navigating to
	// user1 resolves to parent(user1)=root, whose chain never contains user1
	// → "No file checkpoint covers this point", files stuck.
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v1\n"));

	const user1 = sm.entries.find(
		(entry) => entry.type === "message" && entry.role === "user",
	);
	if (!user1) throw new Error("no user entry");
	const result = await navigate(user1.id, "Restore conversation + files");
	expect(result?.cancel).toBeUndefined();

	// full dialog (not the no-checkpoint fallback), and disk is pre-session
	expect(ui.selects.at(-1)?.options).toContain("Restore conversation + files");
	expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("v0\n");
});

test("turn granularity: rewinding to turn N restores state after turn N-1", async () => {
	// Before the fix: with only turn-start refs (all bound to user entries),
	// selecting user-N matched turn-start(user-N-1) = state BEFORE turn N-1
	// — one full turn too far back, silently reverting turn N-1's output.
	process.env.OMP_REWIND_GRANULARITY = "turn";
	try {
		await bootHost(workspace); // fresh instance picks up the env
		await runTurn(() => writeFile(join(workspace, "m.txt"), "1\n"));
		await runTurn(() => writeFile(join(workspace, "m.txt"), "2\n"));
		const user3 = sm.add("message", "user");
		await host.emit("before_agent_start", {}, ctx);
		await writeFile(join(workspace, "m.txt"), "3\n");

		await navigate(user3.id, "Restore conversation + files");
		// state after turn 2 — NOT after turn 1
		expect(await readFile(join(workspace, "m.txt"), "utf-8")).toBe("2\n");
		// and the checkpoint was exact, not an ancestor approximation
		expect(ui.selects.at(-1)?.title).not.toContain("ancestor");
	} finally {
		delete process.env.OMP_REWIND_GRANULARITY;
	}
});

test("session replaced without session_start (/new): next turn rebinds and checkpoints", async () => {
	// Probed against real omp (rpc new_session): session_start does NOT
	// re-fire; before the fix every handler early-returned on the stale
	// sessionId — zero refs for the new session, forever, silently.
	await runTurn(() => writeFile(join(workspace, "a.txt"), "s1\n"));

	// OMP swaps the live session in place; same ctx, new id, fresh tree.
	sm.sessionId = "ffffffff-1111-2222-3333-444444444444";
	sm.entries = [];
	sm.leafId = null;
	await runTurn(() => writeFile(join(workspace, "a.txt"), "s2\n"));

	const refs = await git(
		["--git-dir", shadowDirFor(workspace), "for-each-ref", "--format=%(refname)", "refs/omp-rewind/"],
		workspace,
	);
	const namespaces = new Set(
		refs.split("\n").filter(Boolean).map((ref) => ref.split("/")[2]),
	);
	expect(namespaces.size).toBe(2);
	expect(namespaces.has("ffffffff-1111-2222-3333-444444444444")).toBe(true);

	// and the new session's own restore loop works end to end
	const turn = sm.entries.find((e) => e.role === "user");
	if (!turn) throw new Error("no user entry in new session");
	await navigate(turn.id, "Restore conversation + files");
	expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("s1\n");
});

test("/rewind-prune with no args shows an interactive scope picker", async () => {
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v1\n"));
	// a second session's ref, to give the picker real counts
	const refsDir = shadowDirFor(workspace);
	await git(
		["--git-dir", refsDir, "update-ref", "refs/omp-rewind/other-session/e9",
			(await git(["--git-dir", refsDir, "for-each-ref", "--format=%(objectname)", "--count=1", "refs/omp-rewind/"], workspace))],
		workspace,
	);

	// Cancel first (no answer queued → select returns undefined): NOTHING is
	// deleted — the picker's escape hatch is a real contract, not decoration.
	await host.runCommand("rewind-prune", "", ctx);
	const before = await git(
		["--git-dir", refsDir, "for-each-ref", "--format=%(refname)", "refs/omp-rewind/"],
		workspace,
	);
	expect(before.split("\n").filter(Boolean)).toHaveLength(3);

	// Picker: choose "This session (…)" → only our refs go, other survives.
	ui.answers.push("This session (2)");
	await host.runCommand("rewind-prune", "", ctx);
	const picker = ui.selects.at(-1);
	expect(picker?.title).toContain("Prune which checkpoints?");
	expect(picker?.title).toContain("keep <N>"); // discoverability of keep
	expect(picker?.options).toEqual([
		"This session (2)",
		"Other sessions (1)",
		"Everything (3) + pack store",
		"Cancel",
	]);
	const refs = await git(
		["--git-dir", refsDir, "for-each-ref", "--format=%(refname)", "refs/omp-rewind/"],
		workspace,
	);
	expect(refs.split("\n").filter(Boolean)).toEqual([
		"refs/omp-rewind/other-session/e9",
	]);
	expect(ui.status.get("omp-rewind")).toContain("0 checkpoints");

	// Unknown arg → usage warning, nothing deleted.
	await host.runCommand("rewind-prune", "bogus", ctx);
	expect(ui.notices.at(-1)?.message).toContain("Usage: /rewind-prune");
});

test("prune drains pending checkpoints — no post-prune ref resurrection", async () => {
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v1\n"));

	// A checkpoint is QUEUED but not awaited (OMP does not await handlers) —
	// without the busy+drain gate it would land after the deletes and
	// resurrect a ref for the just-pruned session.
	sm.add("message", "toolResult");
	const floating = host.emit("tool_execution_end", { toolName: "bash" }, ctx);

	await host.runCommand("rewind-prune", "current", ctx);
	await floating;

	const refs = await git(
		["--git-dir", shadowDirFor(workspace), "for-each-ref", "--format=%(refname)", "refs/omp-rewind/"],
		workspace,
	);
	expect(refs.split("\n").filter(Boolean)).toEqual([]);
	expect(ui.status.get("omp-rewind")).toContain("0 checkpoints");
});

test("prune peer refusal is scope-aware; refs stay intact on refusal", async () => {
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v1\n"));
	const shadowDir = shadowDirFor(workspace);
	const listRefs = async () =>
		(
			await git(
				["--git-dir", shadowDir, "for-each-ref", "--format=%(refname)", "refs/omp-rewind/"],
				workspace,
			)
		)
			.split("\n")
			.filter(Boolean);
	const forgePeer = async (sessionId: string) => {
		await mkdir(join(shadowDir, "presence"), { recursive: true });
		const record: PresenceRecord = {
			pid: process.ppid,
			sessionId,
			busy: false, // idle is NOT safe: a checkpoint may be in flight
			updatedAt: new Date().toISOString(),
		};
		await writeFile(
			join(shadowDir, "presence", `${process.ppid}.json`),
			JSON.stringify(record),
		);
	};

	const before = await listRefs();
	expect(before.length).toBeGreaterThan(0);

	// any peer → 'all' refused, refs COMPLETELY unchanged
	await forgePeer("peer-session");
	await host.runCommand("rewind-prune", "all", ctx);
	expect(ui.notices.at(-1)?.message).toContain("Refusing 'all'");
	expect(await listRefs()).toEqual(before);

	// SAME-session peer → 'current' refused, refs COMPLETELY unchanged
	// (a peer that resumed this session would resurrect them right after)
	await forgePeer(ctx.sessionManager.getSessionId());
	await host.runCommand("rewind-prune", "current", ctx);
	expect(ui.notices.at(-1)?.message).toContain("Refusing 'current'");
	expect(await listRefs()).toEqual(before);

	// same-session peer → 'others' fine (no other-session sessions to hurt)
	await host.runCommand("rewind-prune", "others", ctx);
	expect(await listRefs()).toEqual(before); // ours are the only refs

	// OTHER-session peer → 'current' allowed and actually deletes ours
	await forgePeer("peer-session");
	await host.runCommand("rewind-prune", "current", ctx);
	expect(await listRefs()).toEqual([]);

	// …and 'others' with an other-session peer is refused
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v2\n"));
	const again = await listRefs();
	expect(again.length).toBeGreaterThan(0);
	await host.runCommand("rewind-prune", "others", ctx);
	expect(ui.notices.at(-1)?.message).toContain("Refusing 'others'");
	expect(await listRefs()).toEqual(again);
});

test("status counter resumes incrementing after prune (current AND all)", async () => {
	// User report (ran `/rewind-prune all`): bar showed 0 and never
	// increased again until restart. `all` is the differential path — it
	// also deletes OUR index file and repacks. Pin the contract for both
	// scopes: post-prune turns create refs AND the status bar reflects
	// them immediately (no restart needed).
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v1\n"));
	expect(ui.status.get("omp-rewind")).toContain("2 checkpoints");

	await host.runCommand("rewind-prune", "current", ctx);
	expect(ui.status.get("omp-rewind")).toContain("0 checkpoints");

	await runTurn(() => writeFile(join(workspace, "a.txt"), "v2\n"));
	expect(ui.status.get("omp-rewind")).toContain("2 checkpoints");

	// `all` (no peers): refs gone, OUR index file gone, store repacked …
	await host.runCommand("rewind-prune", "all", ctx);
	expect(ui.notices.at(-1)?.message).toContain("Pruned");
	expect(ui.status.get("omp-rewind")).toContain("0 checkpoints");
	await expect(
		stat(join(shadowDirFor(workspace), `index-${SESSION}-${process.pid}`)),
	).rejects.toThrow();

	// … and the very next turn rebuilds the index from scratch, creates
	// refs, and the bar increments WITHOUT a restart.
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v3\n"));
	expect(ui.status.get("omp-rewind")).toContain("2 checkpoints");
	const refs = await git(
		["--git-dir", shadowDirFor(workspace), "for-each-ref", "--format=%(refname)", "refs/omp-rewind/"],
		workspace,
	);
	expect(refs.split("\n").filter(Boolean)).toHaveLength(2);

	// and empty args NEVER deletes anything without an explicit choice:
	// no queued answer → picker returns undefined → refs untouched
	await host.runCommand("rewind-prune", "", ctx);
	expect(ui.status.get("omp-rewind")).toContain("2 checkpoints");
});

test("nested-repo gate: dialog drops files option AND the skip is announced", async () => {
	// User-facing failure mode behind "回退不会撤销文件改动": a gate silently
	// downgraded the restore to conversation-only. The gate must (a) remove
	// the files option and (b) say afterwards that files were NOT restored.
	workspace = await realpath(await mkdtemp(join(tmpdir(), "omp-rewind-nested-")));
	await bootHost(workspace);

	const child = join(workspace, "child");
	await mkdir(child);
	await git(["init", "-b", "main"], child);
	await git(["config", "user.email", "t@t"], child);
	await git(["config", "user.name", "t"], child);
	await writeFile(join(child, "inner.txt"), "x\n");
	await git(["add", "."], child);
	await git(["commit", "-m", "c"], child);

	const turn1 = await runTurn(() => writeFile(join(workspace, "a.txt"), "v1\n"));
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v2\n"));

	await navigate(turn1.id, "Restore conversation only");
	const dialog = ui.selects.at(-1);
	expect(dialog?.options).toEqual(["Restore conversation only", "Cancel"]);
	expect(dialog?.title).toContain("Nested git repositor");
	// files stayed put — and the extension SAID so
	expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("v2\n");
	expect(ui.notices.at(-1)?.message).toContain("Files were NOT restored");
});

test("session swap without session_start (/clear): status rebinds immediately", async () => {
	// User report: after /clear the bar kept showing the PREVIOUS session's
	// count until the next turn (or /rewind-prune) forced a lazy rebind.
	// session_switch/session_branch must rebind eagerly.
	await runTurn(() => writeFile(join(workspace, "a.txt"), "v1\n"));
	expect(ui.status.get("omp-rewind")).toContain("2 checkpoints");

	// OMP swaps the live session in place (/clear): new id, fresh tree.
	sm.sessionId = "cccccccc-1111-2222-3333-444444444444";
	sm.entries = [];
	sm.leafId = null;
	await host.emit("session_switch", {}, ctx);
	expect(ui.status.get("omp-rewind")).toContain("0 checkpoints");
});
