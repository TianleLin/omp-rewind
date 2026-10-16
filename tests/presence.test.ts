/**
 * presence tests — the cross-process contract: records roundtrip, the
 * caller never sees itself, dead pids and corrupt records are garbage-
 * collected, and a live peer's busy flag survives the trip.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearPresence,
	listPeers,
	type PresenceRecord,
	writePresence,
} from "../src/presence.ts";

let gitDir: string;

beforeEach(async () => {
	gitDir = await mkdtemp(join(tmpdir(), "omp-rewind-presence-"));
});

afterEach(async () => {
	await rm(gitDir, { recursive: true, force: true });
});

/** Forge a peer record as another process would have written it. */
async function forgePeer(
	pid: number,
	overrides: Partial<PresenceRecord> = {},
): Promise<void> {
	const record: PresenceRecord = {
		pid,
		sessionId: "peer-session",
		busy: false,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
	await mkdir(join(gitDir, "presence"), { recursive: true });
	await writeFile(
		join(gitDir, "presence", `${pid}.json`),
		JSON.stringify(record),
	);
}

test("own record is written but never reported as a peer", async () => {
	await writePresence(gitDir, "my-session", true);
	expect(await readdir(join(gitDir, "presence"))).toEqual([
		`${process.pid}.json`,
	]);
	expect(await listPeers(gitDir)).toEqual([]);
});

test("a live busy peer roundtrips with a fresh age", async () => {
	// ppid is a real, live, foreign pid from this process's point of view.
	const peerPid = process.ppid;
	await forgePeer(peerPid, { busy: true });

	const peers = await listPeers(gitDir);
	expect(peers).toHaveLength(1);
	expect(peers[0]?.pid).toBe(peerPid);
	expect(peers[0]?.busy).toBe(true);
	expect(peers[0]?.sessionId).toBe("peer-session");
	expect(peers[0]?.ageMs).toBeLessThan(5_000);
});

test("busy=false peers are reported as idle", async () => {
	await forgePeer(process.ppid, { busy: false });
	const peers = await listPeers(gitDir);
	expect(peers).toHaveLength(1);
	expect(peers[0]?.busy).toBe(false);
});

test("dead pids are garbage-collected, live ones survive", async () => {
	// pid_max is 2^22 on 64-bit Linux and far lower on macOS: guaranteed dead.
	const deadPid = 2 ** 24;
	await forgePeer(deadPid, { busy: true });
	await forgePeer(process.ppid);

	const peers = await listPeers(gitDir);
	expect(peers.map((p) => p.pid)).toEqual([process.ppid]);
	expect(await readdir(join(gitDir, "presence"))).toEqual([
		`${process.ppid}.json`,
	]);
});

test("corrupt records of live pids are deleted, not reported", async () => {
	await mkdir(join(gitDir, "presence"), { recursive: true });
	await writeFile(
		join(gitDir, "presence", `${process.ppid}.json`),
		"{ not json",
	);
	expect(await listPeers(gitDir)).toEqual([]);
	expect(await readdir(join(gitDir, "presence"))).toEqual([]);
});

test("non-record files are ignored", async () => {
	await mkdir(join(gitDir, "presence"), { recursive: true });
	await writeFile(join(gitDir, "presence", "README"), "hi");
	await writeFile(join(gitDir, "presence", "0.json"), "{}");
	await writeFile(join(gitDir, "presence", `${process.pid}.json.7.tmp`), "x");
	expect(await listPeers(gitDir)).toEqual([]);
});

test("clearPresence removes own record and tolerates absence", async () => {
	await writePresence(gitDir, "s", false);
	await clearPresence(gitDir);
	expect(await readdir(join(gitDir, "presence"))).toEqual([]);
	await clearPresence(gitDir); // second call: no throw on missing file
});

test("listPeers on a shadow without presence dir returns empty", async () => {
	expect(await listPeers(gitDir)).toEqual([]);
});

test("stale timestamps surface as large ageMs", async () => {
	const old = new Date(Date.now() - 30 * 60_000).toISOString();
	await forgePeer(process.ppid, { busy: true, updatedAt: old });
	const peers = await listPeers(gitDir);
	expect(peers[0]?.ageMs).toBeGreaterThan(29 * 60_000);
});
