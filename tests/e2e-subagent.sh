#!/usr/bin/env bash
# E2E: run a real omp session that spawns a subagent, then assert every
# shadow checkpoint ref lives under exactly ONE session namespace (the main
# session). Before the child-session guard fix, refs landed under two.
#
# Requires: omp on PATH with a working model. Not run in CI.
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WS="$(mktemp -d /tmp/omp-rewind-e2e.XXXXXX)"
trap 'rm -rf "$WS"' EXIT

git -C "$WS" init -q -b main
git -C "$WS" -c user.email=e2e@test -c user.name=e2e commit -q --allow-empty -m init
WS="$(git -C "$WS" rev-parse --show-toplevel)" # resolve /tmp symlink (macOS)

echo "workspace: $WS"
(cd "$WS" && omp -p -e "$EXT_DIR/src/index.ts" \
  "Spawn one subagent via the task tool (agent: sonic) with task: run the bash command 'echo sub >> $WS/touched.txt'. Wait for it with the job tool. Then yourself run bash 'echo main >> $WS/touched.txt' and reply DONE.")

test -f "$WS/touched.txt" || { echo "FAIL: subagent/main writes missing"; exit 1; }

HASH="$(printf '%s' "$WS" | shasum -a 256 | cut -c1-16)"
SHADOW="$HOME/.omp/agent/cache/omp-rewind/$HASH"
test -d "$SHADOW" || { echo "FAIL: shadow dir missing: $SHADOW"; exit 1; }

REFS="$(git --git-dir "$SHADOW" for-each-ref --format='%(refname)' refs/omp-rewind/)"
echo "$REFS"
COUNT="$(echo "$REFS" | grep -c . || true)"
SESSIONS="$(echo "$REFS" | cut -d/ -f3 | sort -u | grep -c . || true)"

echo "refs=$COUNT distinct-session-namespaces=$SESSIONS"
[ "$COUNT" -ge 2 ] || { echo "FAIL: expected >=2 checkpoint refs"; exit 1; }
[ "$SESSIONS" -eq 1 ] || { echo "FAIL: refs leaked into $SESSIONS session namespaces (child-session guard broken)"; exit 1; }

echo "PASS: $COUNT refs, all in one (main) session namespace"
