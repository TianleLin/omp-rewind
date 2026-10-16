/**
 * omp-rewind — cross-process presence.
 *
 * The process-global claim (index.ts) dedupes instances INSIDE one omp
 * process; it cannot see a second omp process on the same workspace. Nothing
 * can actually stop that other process's agent from writing files, so this
 * layer does the only honest thing: each instance advertises itself in a
 * small file under the shadow git dir, and the restore dialog blocks (with
 * a force escape hatch) while a live peer claims to be mid-turn.
 *
 * File: <shadow-gitDir>/presence/<pid>.json — keyed by pid, replaced
 * atomically (tmp + rename, so readers never see a torn record), deleted on
 * shutdown. Dead pids are garbage-collected by whoever reads them next, so
 * crashes leave no permanent lie.
 */

import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export interface PresenceRecord {
	pid: number;
	sessionId: string;
	/** An agent turn is in flight (files may be written any moment). */
	busy: boolean;
	/** ISO timestamp of the last state change or tool completion. */
	updatedAt: string;
}

/** A live peer process on the same shadow (never includes the caller). */
export interface Peer {
	pid: number;
	sessionId: string;
	busy: boolean;
	/** Milliseconds since the peer last updated its record. */
	ageMs: number;
}

const presenceDir = (gitDir: string) => join(gitDir, "presence");

/** Unique tmp names so overlapping writes from one process never collide. */
let writeSeq = 0;

/**
 * Advertise this process's state. Failures are swallowed — presence is
 * advisory and must never break checkpointing or the agent loop.
 */
export async function writePresence(
	gitDir: string,
	sessionId: string,
	busy: boolean,
): Promise<void> {
	try {
		const dir = presenceDir(gitDir);
		await mkdir(dir, { recursive: true });
		const record: PresenceRecord = {
			pid: process.pid,
			sessionId,
			busy,
			updatedAt: new Date().toISOString(),
		};
		const file = join(dir, `${process.pid}.json`);
		const tmp = `${file}.${++writeSeq}.tmp`;
		await writeFile(tmp, JSON.stringify(record));
		await rename(tmp, file);
	} catch {
		// advisory only
	}
}

/** Remove this process's record (graceful shutdown). */
export async function clearPresence(gitDir: string): Promise<void> {
	await rm(join(presenceDir(gitDir), `${process.pid}.json`), {
		force: true,
	}).catch(() => {});
}

/**
 * List OTHER live omp processes on this shadow. Records whose pid is dead
 * or whose content is corrupt (crashed writer legacy — rename is atomic,
 * torn reads cannot happen) are deleted on the way.
 */
export async function listPeers(gitDir: string): Promise<Peer[]> {
	const dir = presenceDir(gitDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const now = Date.now();
	const peers: Peer[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const pid = Number.parseInt(name.slice(0, -".json".length), 10);
		if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;

		let alive: boolean;
		try {
			process.kill(pid, 0);
			alive = true;
		} catch (error) {
			// EPERM = exists but owned by someone else; err on "alive".
			alive =
				error instanceof Error &&
				"code" in error &&
				error.code === "EPERM";
		}

		const file = join(dir, name);
		if (!alive) {
			await rm(file, { force: true }).catch(() => {});
			continue;
		}
		try {
			const record = JSON.parse(
				await readFile(file, "utf-8"),
			) as PresenceRecord;
			peers.push({
				pid,
				sessionId: String(record.sessionId ?? ""),
				busy: record.busy === true,
				ageMs: Math.max(0, now - Date.parse(record.updatedAt ?? "")) || 0,
			});
		} catch {
			await rm(file, { force: true }).catch(() => {});
		}
	}
	return peers;
}
