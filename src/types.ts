/**
 * omp-rewind — structural types for the OMP extension surface we consume.
 *
 * Deliberately self-contained: this extension targets OMP (pi-compatible),
 * and the exact payload shapes (e.g. TreePreparation) are OMP's, not
 * upstream pi's. Structural typing keeps the typecheck offline and honest.
 */

export interface SessionEntryLike {
	id: string;
	parentId: string | null;
	type: string;
	role?: string;
	message?: { role?: string };
}

export interface SessionManagerLike {
	getSessionId(): string;
	getEntries(): SessionEntryLike[];
	getEntry(id: string): SessionEntryLike | undefined;
	getBranch(fromId?: string): SessionEntryLike[];
}

export interface ExtensionUiLike {
	notify(message: string, level: "info" | "warning" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	setStatus(key: string, text: string | undefined): void;
}

export interface ExtensionContextLike {
	cwd: string;
	hasUI: boolean;
	ui: ExtensionUiLike;
	sessionManager: SessionManagerLike;
	isIdle?(): boolean;
	abort?(): void | Promise<void>;
}

/** Payload of `session_before_tree` (OMP passes TreePreparation fields). */
export interface TreePreparationLike {
	targetId?: string;
	oldLeafId?: string | null;
	signal?: AbortSignal;
	/** upstream pi nests the preparation; OMP flattens — support both */
	preparation?: { targetId?: string; oldLeafId?: string | null; signal?: AbortSignal };
}

export interface BeforeTreeResult {
	cancel?: boolean;
}

export interface PiApiLike {
	on(
		event: string,
		handler: (event: never, ctx: ExtensionContextLike) => unknown,
	): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler: (args: string, ctx: ExtensionContextLike) => Promise<void> | void;
		},
	): void;
	logger?: { warn?(message: string): void };
}
