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
- **Safety**: gitignored files never enter snapshots and are never deleted by restores (tracked-but-ignored files are force-included). Untracked files that existed at checkpoint time come back untracked.

## Requirements
- OMP with extension support
- `git` on PATH; the workspace must be a git repository (the extension disables itself otherwise, with a notice)

## Install

```bash
omp install /path/to/omp-rewind   # or: pi install …
```

## Configuration

| Env var | Values | Default | Effect |
|---|---|---|---|
| `OMP_REWIND_GRANULARITY` | `tool` \| `turn` | `tool` | `turn` skips per-tool checkpoints (only turn-start snapshots) |

## Commands

- `/rewind-prune` — delete checkpoint refs from **other** sessions
- `/rewind-prune all` — delete every omp-rewind ref including the current session, then `gc` the shadow store

Refs are never deleted automatically; old sessions keep working file restores after `/resume`.

## Edge behavior

| Situation | Behavior |
|---|---|
| Node older than any checkpoint | Conversation restores; files untouched; dialog says so explicitly |
| Agent running when you navigate | Aborts and waits for idle before restoring |
| Branch switched since checkpoint | File restore refused with the branch name; conversation unaffected |
| Commits after checkpoint | Kept — restore only rewrites worktree + index |
| Non-git directory | Extension disabled with a notice |

## Subagents (`task` tool)

- OMP re-imports extensions for every subagent child session; omp-rewind detects this via a process-global claim and stays **inert in child sessions** — only the main session writes checkpoints. (Verified e2e: a run that spawns a subagent produces refs in exactly one session namespace.)
- A subagent's file changes land between two main-tree anchors (the `task` call and its result injection). Rewinding to the user turn that spawned it reverts **all** of its changes atomically; the leaving checkpoint keeps redo working.
- Mid-subagent granularity does not exist by design — child sessions are not part of the main session tree. Use `isolated: true` tasks if you want subagent work to land atomically via patch/branch merge.
- **Esc does not stop background subagents.** Esc only interrupts the main agent loop; background jobs keep running and keep writing files. Cancel them first (`job cancel <id>`, Agent Hub, or irc) before rewinding — the restore dialog reminds you whenever the session has spawned subagents.
- Stop → undo → switch model → re-run: `job cancel` the subagent, double-Esc to the user turn that spawned it, restore conversation + files, edit the prompt (pick a different agent type — per-spawn model override is not part of the task schema), resubmit.

## Development

```bash
bun install
bun test                  # git-backed contract tests
bunx tsc --noEmit         # typecheck
./tests/e2e-subagent.sh   # real-omp e2e: subagent runs stay out of the shadow store
```

## Design lineage

Built after a post-mortem of [pi-undo-redo](https://github.com/justram/pi-undo-redo) (sandbox virtualization — precise but environment-distorting) and [pi-rewind](https://github.com/arpagon/pi-rewind) (git checkpoints — sound engine, but timestamp-matched to the conversation and `reset --hard` on restore). This extension keeps pi-rewind's temp-index snapshot engine, replaces timestamp correlation with exact entry-ID binding, and never moves HEAD.
