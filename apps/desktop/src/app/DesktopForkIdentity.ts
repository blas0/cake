/**
 * Who this build is, on a machine where the real T3 Code is also installed.
 *
 * This is a fork. It is developed on a laptop where upstream T3 Code is running
 * all day, and the two must not share a byte of state. Electron scopes the
 * single-instance lock to the userData directory, so reusing upstream's name
 * does not merely mean reading the same files — the fork either refuses to
 * start or starts and writes into the live install's database.
 *
 * The names live here, alone and exported, for two reasons. They are the first
 * thing to check when the fork misbehaves next to upstream, and they are the
 * one part of this fork that must survive a merge from origin/main untouched —
 * a rename scattered across the call sites would be re-conflicted on every
 * pull.
 *
 * Not covered here: `~/.t3` itself. That directory is shared with upstream even
 * in dev mode, because `caches/` and `worktrees/` hang off the base dir rather
 * than the per-mode state dir. Launch through `scripts/cake-dev.sh`, which
 * passes an explicit fork-local home and clears an inherited T3CODE_HOME.
 */

/**
 * The slug and the scheme come from contracts, not from here. The server has to
 * allow the renderer's origin, and it cannot import this file — so when the
 * scheme was defined here alone, renaming the fork silently broke CORS for
 * every request the app made. One definition, imported by both, is what stops
 * that from being possible.
 */
export { FORK_SLUG, UPSTREAM_SLUG, desktopScheme } from "@t3tools/contracts";

import { FORK_SLUG } from "@t3tools/contracts";

export function userDataDirName(isDevelopment: boolean): string {
  return isDevelopment ? `${FORK_SLUG}-dev` : FORK_SLUG;
}

/**
 * The pre-slug directory name, preferred by `resolveUserDataPath` when it
 * already exists on disk. It has to be fork-specific too: leave it upstream and
 * a stale "T3 Code (Dev)" folder wins, so the rename looks applied and changes
 * nothing.
 */
export function legacyUserDataDirName(isDevelopment: boolean): string {
  return isDevelopment ? "T3 Code Cakefork (Dev)" : "T3 Code Cakefork";
}
