#!/usr/bin/env bash
#
# Launch the cakefork dev app beside the installed T3 Code.
#
# Renaming the app's identity is not enough on its own. Two paths still lead
# back to the live install, and both are closed here rather than in code,
# because both are properties of the environment the app is launched from.
#
#   1. `~/.t3/caches` and `~/.t3/worktrees` hang off the base dir, not the
#      per-mode state dir, so dev mode shares them with production. `--home-dir`
#      moves the whole base dir — state, caches and worktrees — under the fork.
#
#   2. T3CODE_HOME is a landmine. The running T3 Code exports it into the shells
#      it spawns for agents, so a dev run started from such a shell inherits it,
#      skips the dev subdirectory, and boots against the production database.
#      An explicit --home-dir already outranks it; clearing it as well means
#      nothing downstream can read it either.
#
# Both are belt and braces on purpose: this is the one mistake in this fork that
# would damage something the user cannot regenerate.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK_HOME="$REPO_ROOT/.t3"

unset T3CODE_HOME

mkdir -p "$FORK_HOME"

echo "cakefork dev"
echo "  repo: $REPO_ROOT"
echo "  home: $FORK_HOME  (production ~/.t3 is untouched)"
echo

exec vp run dev:desktop --home-dir "$FORK_HOME" "$@"
