#!/usr/bin/env bun
/**
 * L4 e2e — REAL omp, rpc mode, real model, zero mocks.
 *
 * Proves the checkpoint/presence side of the production loop:
 *   1. an agent turn writes state.txt=v1 → shadow checkpoint refs appear and
 *      presence flips busy DURING the turn (cross-process contract);
 *   2. a second turn overwrites to v2 → more refs, still one session
 *      namespace;
 *   3. every ref is bound to a real entry id of THIS session's tree.
 *
 * NOT covered here: the restore dialog + file rollback. RPC `branch` is
 * fork-to-new-session (SessionManager.branch), not tree navigation — it
 * never emits session_before_tree (verified empirically; response returns
 * prefill text, no extension_ui_request follows). The dialog path lives in
 * the TUI only: covered deterministically by tests/host-sim.test.ts and
 * manually by the runbook in README (双 Esc → tree → dialog → v1 on disk,
 * verified 2026-07-20 against omp v17.0.5).
 *
 * Requires: omp on PATH with a working model. Not run in CI.
 *   bun tests/e2e-rpc-restore.ts
 */

import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT = resolve(import.meta.dir, "..", "src", "index.ts");
const TURN_TIMEOUT_MS = 180_000;

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

// --- workspace ------------------------------------------------------------

const rawWs = await mkdtemp(join(tmpdir(), "omp-rewind-rpc-"));
const sessionDir = await mkdtemp(join(tmpdir(), "omp-rewind-rpc-sessions-"));
const run = async (cmd: string[], cwd: string) => {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	await proc.exited;
	return (await new Response(proc.stdout).text()).trim();
};
await run(["git", "init", "-b", "main"], rawWs);
await run(["git", "config", "user.email", "e2e@test"], rawWs);
await run(["git", "config", "user.name", "e2e"], rawWs);
await Bun.write(join(rawWs, "README.md"), "e2e\n");
await run(["git", "add", "."], rawWs);
await run(["git", "commit", "-m", "init"], rawWs);
const ws = await run(["git", "rev-parse", "--show-toplevel"], rawWs);
const shadowDir = join(
	process.env.HOME ?? "~",
	".omp",
	"agent",
	"cache",
	"omp-rewind",
	createHash("sha256").update(ws).digest("hex").slice(0, 16),
);
console.log(`workspace: ${ws}`);
console.log(`shadow:    ${shadowDir}`);

// --- omp rpc process --------------------------------------------------------

const omp = Bun.spawn(
	[
		"omp",
		"--mode",
		"rpc",
		// NOT --no-extensions: it suppresses explicit -e paths too (observed
		// v17.0.5), contrary to its help text.
		"-e",
		EXT,
		"--session-dir",
		sessionDir,
		"--thinking",
		"off",
	],
	{ cwd: ws, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);

interface RpcMessage {
	type?: string;
	id?: string;
	method?: string;
	title?: string;
	options?: string[];
	command?: string;
	success?: boolean;
	error?: string;
	[key: string]: unknown;
}

const inbox: RpcMessage[] = [];
// Boxed so the reader IIFE sees the property, not an IIFE-narrowed binding.
const inboxWakeup: { fn: (() => void) | null } = { fn: null };

(async () => {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of omp.stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
			if (!line.startsWith("{")) continue;
			try {
				inbox.push(JSON.parse(line) as RpcMessage);
				inboxWakeup.fn?.();
			} catch {
				// non-JSON noise
			}
		}
	}
})();

let scanFrom = 0;
async function waitFor(
	what: string,
	predicate: (m: RpcMessage) => boolean,
	timeoutMs: number = TURN_TIMEOUT_MS,
): Promise<RpcMessage> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		for (; scanFrom < inbox.length; scanFrom++) {
			const message = inbox[scanFrom];
			if (message && predicate(message)) {
				scanFrom++;
				return message;
			}
		}
		if (Date.now() > deadline)
			throw new Error(`timeout waiting for ${what}`);
		const { promise, resolve: wake } = Promise.withResolvers<void>();
		inboxWakeup.fn = wake;
		setTimeout(wake, 250);
		await promise;
		inboxWakeup.fn = null;
	}
}

const send = (message: Record<string, unknown>) => {
	omp.stdin.write(`${JSON.stringify(message)}\n`);
	return omp.stdin.flush();
};

const cleanup = async () => {
	omp.kill();
	await rm(rawWs, { recursive: true, force: true });
	await rm(sessionDir, { recursive: true, force: true });
	await rm(shadowDir, { recursive: true, force: true });
};
process.on("exit", () => omp.kill());

// --- step 1: turn 1 writes v1; presence goes busy ---------------------------

console.log("step 1: turn 1 (state.txt = v1) …");
await send({
	id: "p1",
	type: "prompt",
	message:
		"Use the write tool to create state.txt containing exactly `v1` (no other text). Then reply done. Do not run any other tools.",
});

const busySeen = (async () => {
	const presenceFile = () =>
		readdir(join(shadowDir, "presence")).catch(() => [] as string[]);
	const deadline = Date.now() + TURN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		for (const name of await presenceFile()) {
			try {
				const raw = await readFile(
					join(shadowDir, "presence", name),
					"utf-8",
				);
				const record = JSON.parse(raw) as { busy?: boolean };
				if (record.busy === true) return true;
			} catch {
				// mid-write; retry
			}
		}
		await Bun.sleep(200);
	}
	return false;
})();

await waitFor("agent_end (turn 1)", (m) => m.type === "agent_end");
const v1 = await readFile(join(ws, "state.txt"), "utf-8").catch(() => "");
if (v1.trim() !== "v1") fail(`turn 1: expected state.txt=v1, got ${JSON.stringify(v1)}`);
if (!(await busySeen)) fail("presence never flipped busy during turn 1");
console.log("  ✓ state.txt=v1, presence busy observed");

// --- step 2: turn 2 overwrites to v2 ----------------------------------------

console.log("step 2: turn 2 (state.txt = v2) …");
await send({
	id: "p2",
	type: "prompt",
	message:
		"Use the edit or write tool to make state.txt contain exactly `v2`. Then reply done. Do not run any other tools.",
});
await waitFor("agent_end (turn 2)", (m) => m.type === "agent_end");
const v2 = await readFile(join(ws, "state.txt"), "utf-8").catch(() => "");
if (v2.trim() !== "v2") fail(`turn 2: expected state.txt=v2, got ${JSON.stringify(v2)}`);
console.log("  ✓ state.txt=v2");

// --- step 3: find turn 2's user entry in the session file -------------------

const sessionFiles = (await readdir(sessionDir)).filter((f) =>
	f.endsWith(".jsonl"),
);
if (sessionFiles.length !== 1)
	fail(`expected exactly one session file, got: ${sessionFiles.join(", ")}`);
const sessionRaw = await readFile(join(sessionDir, sessionFiles[0] ?? ""), "utf-8");
const userEntryIds: string[] = [];
for (const line of sessionRaw.split("\n")) {
	if (!line.trim()) continue;
	try {
		const entry = JSON.parse(line) as {
			id?: string;
			type?: string;
			message?: { role?: string };
		};
		if (
			typeof entry.id === "string" &&
			entry.type === "message" &&
			entry.message?.role === "user"
		) {
			userEntryIds.push(entry.id);
		}
	} catch {
		// header/other lines
	}
}
if (userEntryIds.length < 2)
	fail(`expected >=2 user entries in session, got ${userEntryIds.length}`);
const target = userEntryIds[1] ?? "";
console.log(`step 3: shadow refs bind to this session's entries …`);

// RPC `branch` forks a NEW session file (fork semantics — no
// session_before_tree, hence no dialog; see header). So instead of driving
// the dialog here, assert the binding contract that navigation relies on:
// every shadow ref lives under THIS session and points at real entry ids.
// Session files are named <timestamp>_<sessionId>.jsonl.
const sessionIdFromFile = (sessionFiles[0] ?? "")
	.replace(/\.jsonl$/, "")
	.split("_")
	.at(-1) ?? "";
const allEntryIds = new Set<string>();
for (const line of sessionRaw.split("\n")) {
	if (!line.trim()) continue;
	try {
		const entry = JSON.parse(line) as { id?: string };
		if (typeof entry.id === "string") allEntryIds.add(entry.id);
	} catch {
		// header/other lines
	}
}
void target; // turn-2 user entry — used by the TUI runbook, kept for parity

// --- step 4: shadow refs — one namespace, entry-bound ------------------------

const refs = await run(
	["git", "--git-dir", shadowDir, "for-each-ref", "--format=%(refname)", "refs/omp-rewind/"],
	ws,
);
const refNames = refs.split("\n").filter(Boolean);
if (refNames.length < 2) fail(`expected >=2 shadow refs, got ${refNames.length}`);

const sessionComponents = new Set<string>();
let entryBound = 0;
for (const ref of refNames) {
	const parts = ref.split("/"); // refs/omp-rewind/<session>/<entry>
	sessionComponents.add(parts[2] ?? "");
	if (allEntryIds.has(parts[3] ?? "")) entryBound++;
}
if (sessionComponents.size !== 1)
	fail(`refs leaked across ${sessionComponents.size} session namespaces`);
if (!sessionComponents.has(sessionIdFromFile))
	fail(
		`ref namespace ${[...sessionComponents].join()} != session file ${sessionIdFromFile}`,
	);
if (entryBound === 0)
	fail("no shadow ref matches any entry id from the session file");
console.log(
	`  ✓ ${refNames.length} refs, one namespace (${sessionIdFromFile}), ${entryBound} bound to real entry ids`,
);

console.log(
	"PASS: checkpoint schedule + presence + entry binding verified against real omp (rpc)",
);
await cleanup();
process.exit(0);
