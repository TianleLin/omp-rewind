# omp-rewind

Session-tree-bound git checkpoints for [OMP](https://github.com/can1357/oh-my-pi). Double-Esc opens OMP's native tree selector; picking a node restores **conversation and files together**, atomically bound by session entry ID — no timestamp guessing.

## How it works

All checkpoint data lives in a **shadow git repository** under `~/.omp/agent/cache/omp-rewind/<workspace-hash>/` whose work-tree points at your workspace. Your repo's own `.git` gains **no refs and no objects** — nothing for `git push --mirror`, GUIs, `git bundle`, or backups to pick up.

- **Checkpoints**: before each agent turn and after each mutating tool call, the full workspace state (tracked + non-ignored untracked files, staged diff as a patch blob, HEAD metadata) is snapshotted through the shadow's persistent per-session index (incremental, no full rescan) into a commit at `refs/omp-rewind/<sessionId>/<entryId>` — in the shadow.
- **Navigation**: `session_before_tree` resolves the target node to its effective new leaf (user messages → parent, matching OMP's own rule), finds the nearest self-or-ancestor checkpoint, shows a diff stat, and asks:
  - `Restore conversation + files` (default)
  - `Restore conversation only`
  - `Cancel`
- **Restore**: worktree files + the staged/unstaged split. HEAD and the branch pointer are **never** moved — commits made after the checkpoint stay on your branch, and the restore shows up as uncommitted changes. Cross-branch restores are blocked. The only write to your repo's `.git` is the index update that reproduces your staged state (that write *is* the restore, and it happens only when you confirm one).
- **Undo**: before restoring, the leaving state is checkpointed against the old leaf. Undo = double-Esc, navigate back to the node you came from. No extra commands, no redo stack.
- **Safety**: currently-ignored files are outside rewind's jurisdiction in **both directions** — never snapshotted, never deleted, never overwritten by restores. All four ignore sources are honored live: worktree `.gitignore` files, the repo's `.git/info/exclude`, the effective `core.excludesFile` (repo-local or global), and the global XDG ignore (the first two are mirrored into the shadow before every index sync; `core.excludesFile` is forwarded per-add at its native precedence slot via `-c`, preserving negation semantics). Ignore rules added **later** also count: every sync evicts shadow-tracked paths that current rules ignore, and every restore strips them from the target tree — a checkpoint that captured a file before it was ignored neither deletes nor clobbers it afterwards. Files the REAL repo tracks stay fully snapshot-scoped even when ignored (force-included and restorable). Untracked files that existed at checkpoint time come back untracked.
- **Folder mode**: a git repository is *not* required. In a plain folder the same shadow machinery snapshots and restores files; the staged-split and branch semantics simply don't apply. With no `.gitignore` present, a built-in exclude list (`node_modules/`, `dist/`, `target/`, `.venv/`, …) keeps junk out of snapshots — a real `.gitignore` in the folder still takes precedence. The status footer shows `(folder)`. **Boundary**: an embedded git repository inside the folder is recorded as a gitlink pointer — its files are in neither snapshots nor restores. To prevent a silently partial restore, **file restore is disabled while nested repos are present** (status shows `⚠ nested repos`; the dialog explains and offers conversation-only). Each nested repo is its own rewind domain: run omp inside it for full-fidelity rewind there.

## Requirements
- OMP with extension support
- `git` on PATH (the extension disables itself otherwise, with a notice) — the workspace does **not** need to be a git repository

## Install

```bash
omp install /path/to/omp-rewind   # or: pi install …
```

## Configuration

| Env var | Values | Default | Effect |
|---|---|---|---|
| `OMP_REWIND_GRANULARITY` | `tool` \| `turn` | `tool` | `turn` skips per-tool checkpoints (only turn-start snapshots) |

## Commands

- `/rewind-prune` — interactive scope picker (mirrors `/compact`): `This session (N)` / `Other sessions (N)` / `Everything (N) + pack store` / `Cancel`
- `/rewind-prune current` — delete this session's checkpoints (alias: `session`). Refused while a live peer has this **same session** resumed (its pending checkpoints would immediately resurrect the refs)
- `/rewind-prune others` — delete every other session's checkpoints. Refused while a live peer is working in an **other** session (would delete its history mid-flight)
- `/rewind-prune keep <N>` — keep this session's **N newest** checkpoints (ordered by millisecond `createdAt` from checkpoint metadata, not git's seconds-only committerdate), delete its older ones — "clear what I'll never rewind to". Fail-closed: refs whose metadata is unreadable are never deleted (survivors may exceed N). Same same-session peer refusal as `current`
- `/rewind-prune all` — delete every ref, drop this process's own index, then repack (`gc --no-prune`). Refused while **any** live peer has the workspace open. **Objects are never pruned without a cross-process lock**: a peer's persistent index may be the only thing keeping its blobs alive, and any prune window would poison its next checkpoint. True disk reclaim = future exclusive-lock work. Peer refusals are UX checks (TOCTOU remains); the structural safety is no-prune gc + per-process index files
- Unknown scopes print usage instead of guessing

Refs are never deleted automatically; old sessions keep working file restores after `/resume`.

## Edge behavior

| Situation | Behavior |
|---|---|
| Node older than any checkpoint | Conversation restores; files untouched; dialog says so explicitly |
| Agent running when you navigate | Aborts and waits for idle before restoring |
| Branch switched since checkpoint | File restore refused with the branch name; conversation unaffected |
| Commits after checkpoint | Kept — restore only rewrites worktree + index |
| Non-git directory | Folder mode: snapshots + restores work; no staged/branch semantics; default excludes |
| Nested git repo not tracked as a submodule (folder mode, or untracked embedded repo in repo mode) | File restore **blocked** (`RestoreBlockedError`; dialog offers conversation-only) — gitlink content is not covered, a partial restore would lie. Guard checks current index ∪ target checkpoint tree. Run omp inside the nested repo instead |
| Real submodule (tracked 160000 in the outer repo) | Not blocked — git-native pointer semantics; restore never enters submodule content |
| `git init` after folder-mode checkpoints | Old checkpoints refuse file restore (state predates the repo); new ones are repo-mode |
| git not installed | Extension disabled with a notice |
| Second omp instance on this workspace, agent running | File restore **blocked by default** — dialog shows the peer's pid and last activity; `Force restore files anyway (unsafe)` is the escape hatch. Stop the other agent (Esc there) first |
| Second omp instance, idle | Dialog notes it; restore proceeds normally |
| Other instance crashed | Its presence record is garbage-collected on the next check — no stale blocks |
| Dirty repo with deleted tracked files | Checkpoints work (deletion recorded); tracked+ignored files force-added only while on disk |
| `/new`, `/resume`, RPC `new_session` mid-process | Next turn/navigation rebinds to the new session automatically (`session_start` does not re-fire) |
| Checkpoint failures | First failure notifies; status bar shows `⚠ failing` until one succeeds — never a silent 0 |
| Rewind to the first user message | Restores pre-session file state (turn-start checkpoints bind to the pre-turn tree position) |

## Multiple omp instances

Every instance advertises itself in `presence/<pid>.json` inside the shadow (busy flag flipped on `agent_start`/`agent_end`, refreshed on every tool completion, removed on shutdown; dead pids are cleaned up by whoever looks next). Before a file restore, the dialog checks for live peers:

- **Peer mid-turn** → its agent keeps writing files during your restore, and nothing can stop it from here. Default is blocked; forcing is explicit and labeled unsafe. Go press Esc in the other window instead.
- **Peer restoring** → a restore marks its instance busy for its duration, so two simultaneous restores also block each other.
- This is detection, not locking: a lock on the shadow could not stop the other process's *tools* from writing to the workspace anyway, so the honest contract is "tell the user, let the only person who can stop it decide."

## Subagents (`task` tool)

- OMP re-imports extensions for every subagent child session; omp-rewind detects this via a process-global claim and stays **inert in child sessions** — only the main session writes checkpoints. (Verified e2e: a run that spawns a subagent produces refs in exactly one session namespace.)
- A subagent's file changes land between two main-tree anchors (the `task` call and its result injection). Rewinding to the user turn that spawned it reverts **all** of its changes atomically; the leaving checkpoint keeps redo working.
- Mid-subagent granularity does not exist by design — child sessions are not part of the main session tree. Use `isolated: true` tasks if you want subagent work to land atomically via patch/branch merge.
- **Esc does not stop background subagents.** Esc only interrupts the main agent loop; background jobs keep running and keep writing files. Cancel them first (`job cancel <id>`, Agent Hub, or irc) before rewinding — the restore dialog reminds you whenever the session has spawned subagents.
- Stop → undo → switch model → re-run: `job cancel` the subagent, double-Esc to the user turn that spawned it, restore conversation + files, edit the prompt (pick a different agent type — per-spawn model override is not part of the task schema), resubmit.

## Development & testing

Four verification layers; each earns its place by catching what the layer below cannot:

```bash
bun install
bunx tsc --noEmit              # typecheck
bun test                       # L1+L2, deterministic, CI-safe (~12s)
bun tests/e2e-rpc-restore.ts   # L3, real omp + real model (~20s, not CI)
./tests/e2e-subagent.sh        # L3b, real omp: subagent refs stay in one namespace
```

| Layer | Files | Proves | Cannot prove |
|---|---|---|---|
| **L1 unit** | `core.test.ts`, `presence.test.ts` | git engine contract (snapshot/restore/split/prune/folder mode), presence file protocol (pid GC, atomicity) | anything about event wiring or dialogs |
| **L2 host-sim** | `host-sim.test.ts` | the REAL `src/index.ts` driven through OMP's exact event sequence (`session_start → before_agent_start → tool_execution_end → session_before_tree → session_tree`) against a real repo + real shadow: checkpoint scheduling, dialog wording/ordering, cancel/conversation-only/force paths, busy-peer blocking, subagent claim, git-missing gate | that OMP actually emits those events with those payloads |
| **L3 real-omp rpc** | `e2e-rpc-restore.ts` | zero mocks: real agent turns create entry-bound refs in one session namespace; presence flips busy mid-turn | the restore dialog — RPC `branch` is fork-to-new-session, it never runs `navigateTree`/`session_before_tree` |
| **L4 real-omp TUI** | manual runbook below | the full user story on the production surface | — |

### L4 runbook (manual, ~2 min)

The dialog + rollback path only exists in the TUI. Verified 2026-07-20 against omp v17.0.5 (driven over PTY; transcript reproducible with any PTY driver):

1. `mkdir /tmp/rw && cd /tmp/rw && git init -b main && git commit --allow-empty -m init`
2. `omp -e <path>/omp-rewind/src/index.ts` — status bar shows `◆ 0 checkpoints`
3. Prompt: *"write state.txt containing exactly v1, reply done"* → `◆ 2 checkpoints`, `state.txt=v1`
4. Prompt: *"edit state.txt to exactly v2, reply done"* → `◆ 4 checkpoints`, `state.txt=v2`
5. Double-Esc (editor must be empty) → tree selector → select turn 2's **user** entry → Enter
6. Dialog shows `File changes to be reverted: state.txt | 2 +-` with `Restore conversation + files / Restore conversation only / Cancel` → confirm first option
7. `cat state.txt` → **v1**; notification `Files restored to checkpoint.`
8. Undo: double-Esc → select turn 2's trailing `assistant: done` → same dialog → confirm → `state.txt` is **v2** again (the pre-restore "leaving" checkpoint)

Step 5 note: selecting a *user* entry restores its **parent** checkpoint (OMP moves the leaf to the parent and prefills the editor with the message — Ctrl+C clears the prefill).

## Design lineage

Built after a post-mortem of [pi-undo-redo](https://github.com/justram/pi-undo-redo) (sandbox virtualization — precise but environment-distorting) and [pi-rewind](https://github.com/arpagon/pi-rewind) (git checkpoints — sound engine, but timestamp-matched to the conversation and `reset --hard` on restore). This extension keeps pi-rewind's temp-index snapshot engine, replaces timestamp correlation with exact entry-ID binding, and never moves HEAD.
