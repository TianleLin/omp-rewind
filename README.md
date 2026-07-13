# omp-rewind

Session-tree-bound git checkpoints for [OMP](https://github.com/can1357/oh-my-pi). Double-Esc opens OMP's native tree selector; picking a node restores **conversation and files together**, atomically bound by session entry ID — no timestamp guessing.

## How it works

- **Checkpoints**: before each agent turn and after each mutating tool call, the full workspace state (tracked + staged + non-ignored untracked files, HEAD metadata) is snapshotted via a temporary git index into a commit object at `refs/omp-rewind/<sessionId>/<entryId>`.
- **Navigation**: `session_before_tree` resolves the target node to its effective new leaf (user messages → parent, matching OMP's own rule), finds the nearest self-or-ancestor checkpoint, shows a diff stat, and asks:
  - `Restore conversation + files` (default)
  - `Restore conversation only`
  - `Cancel`
- **Restore**: worktree + index only. HEAD and the branch pointer are **never** moved — commits made after the checkpoint stay on your branch, and the restore shows up as uncommitted changes. Cross-branch restores are blocked.
- **Undo**: before restoring, the leaving state is checkpointed against the old leaf. Undo = double-Esc, navigate back to the node you came from. No extra commands, no redo stack.
- **Safety**: gitignored files are invisible to snapshots and never deleted by restores. Untracked files that existed at checkpoint time are restored untracked (staged/unstaged split is preserved exactly).

## Requirements

- OMP with extension support
- The workspace must be a git repository (the extension disables itself otherwise, with a notice)

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
- `/rewind-prune all` — delete every omp-rewind ref including the current session

Refs are never deleted automatically; old sessions keep working file restores after `/resume`.

## Edge behavior

| Situation | Behavior |
|---|---|
| Node older than any checkpoint | Conversation restores; files untouched; dialog says so explicitly |
| Agent running when you navigate | Aborts and waits for idle before restoring |
| Branch switched since checkpoint | File restore refused with the branch name; conversation unaffected |
| Commits after checkpoint | Kept — restore only rewrites worktree + index |
| Non-git directory | Extension disabled with a notice |

## Development

```bash
bun install
bun test          # git-backed contract tests
bunx tsc --noEmit # typecheck
```

## Design lineage

Built after a post-mortem of [pi-undo-redo](https://github.com/justram/pi-undo-redo) (sandbox virtualization — precise but environment-distorting) and [pi-rewind](https://github.com/arpagon/pi-rewind) (git checkpoints — sound engine, but timestamp-matched to the conversation and `reset --hard` on restore). This extension keeps pi-rewind's temp-index snapshot engine, replaces timestamp correlation with exact entry-ID binding, and never moves HEAD.
