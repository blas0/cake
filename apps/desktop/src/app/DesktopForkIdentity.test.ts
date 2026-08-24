// @effect-diagnostics nodeBuiltinImport:off - Reads electron-launcher.mjs as plain text to
// check its scheme literals have not drifted; there is no Effect runtime in this suite.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  FORK_SLUG,
  UPSTREAM_SLUG,
  desktopScheme,
  legacyUserDataDirName,
  userDataDirName,
} from "./DesktopForkIdentity.ts";

/**
 * This fork runs on a machine where the real T3 Code is installed and running.
 * Every name below decides whether the two share state: Electron scopes the
 * single-instance lock to the userData directory, so a fork that reuses
 * upstream's name does not merely read the same files — it refuses to start,
 * or worse, starts and writes into them.
 *
 * The collision assertions matter more than the equality ones. A typo that
 * renames dev but leaves prod alone still passes "is it t3code-cakefork-dev?"
 * and still points a packaged fork at the live install.
 */
describe("fork identity", () => {
  it("names the userData directory after the fork, per mode", () => {
    assert.strictEqual(userDataDirName(true), `${FORK_SLUG}-dev`);
    assert.strictEqual(userDataDirName(false), FORK_SLUG);
  });

  it("never yields an upstream userData directory in either mode", () => {
    for (const isDevelopment of [true, false]) {
      const name = userDataDirName(isDevelopment);
      assert.notStrictEqual(name, UPSTREAM_SLUG);
      assert.notStrictEqual(name, `${UPSTREAM_SLUG}-dev`);
      assert.isTrue(name.startsWith(FORK_SLUG));
    }
  });

  /**
   * The legacy name is a fallback: resolveUserDataPath prefers it when the
   * directory already exists. Leave it upstream and a stale "T3 Code (Dev)"
   * folder silently wins over the fork's own — the rename would look applied
   * and do nothing.
   */
  it("never falls back to an upstream legacy directory", () => {
    for (const isDevelopment of [true, false]) {
      const legacy = legacyUserDataDirName(isDevelopment);
      assert.notStrictEqual(legacy, "T3 Code (Alpha)");
      assert.notStrictEqual(legacy, "T3 Code (Dev)");
      assert.include(legacy.toLowerCase(), "cakefork");
    }
  });

  it("registers fork-specific URL schemes", () => {
    assert.strictEqual(desktopScheme(true), `${FORK_SLUG}-dev`);
    assert.strictEqual(desktopScheme(false), FORK_SLUG);
  });

  /**
   * Claiming `t3code://` would hand the fork deep links meant for the real
   * app — the one failure here that reaches outside this process.
   */
  it("never claims an upstream URL scheme", () => {
    for (const isDevelopment of [true, false]) {
      const scheme = desktopScheme(isDevelopment);
      assert.notStrictEqual(scheme, UPSTREAM_SLUG);
      assert.notStrictEqual(scheme, `${UPSTREAM_SLUG}-dev`);
    }
  });

  /**
   * The dev launcher is plain .mjs and cannot import this TypeScript module, so
   * it repeats the scheme list as a literal. Duplication that nothing checks is
   * duplication that drifts: the launcher writes CFBundleURLTypes into the dev
   * .app, so a stale literal registers the upstream scheme with LaunchServices
   * while every test above still passes.
   */
  it("keeps the dev launcher's scheme literals in step", () => {
    const launcherPath = NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "..",
      "..",
      "scripts",
      "electron-launcher.mjs",
    );
    const source = NodeFS.readFileSync(launcherPath, "utf8");
    const match = source.match(
      /APP_PROTOCOL_SCHEMES\s*=\s*isDevelopment\s*\?\s*\[(.*?)\]\s*:\s*\[(.*?)\]/s,
    );
    assert.isNotNull(match, "could not find APP_PROTOCOL_SCHEMES in electron-launcher.mjs");

    const schemesFrom = (group: string): ReadonlyArray<string> =>
      [...group.matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]!);

    assert.deepStrictEqual(schemesFrom(match![1]!), [desktopScheme(true)]);
    assert.deepStrictEqual(schemesFrom(match![2]!), [desktopScheme(false)]);
  });
});
