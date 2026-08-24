import { describe, expect, it } from "vite-plus/test";

import { cakeAvatarHash } from "./cakeIdentity.ts";

/**
 * A cake's avatar is how it is recognised in a list, in the right sidebar, and
 * inside the fork dialog. Recognition only works if the picture is stable.
 */
describe("cakeAvatarHash", () => {
  it("is the same for the same cake", () => {
    expect(cakeAvatarHash({ id: "cake-1", name: "Nightly" })).toBe(
      cakeAvatarHash({ id: "cake-1", name: "Nightly" }),
    );
  });

  /**
   * Renaming a cake must not change its face. The name is the one field a user
   * edits casually, and an avatar that shifts underneath a rename teaches them
   * the picture means nothing.
   */
  it("survives a rename", () => {
    expect(cakeAvatarHash({ id: "cake-1", name: "Nightly" })).toBe(
      cakeAvatarHash({ id: "cake-1", name: "Renamed entirely" }),
    );
  });

  it("differs between cakes", () => {
    expect(cakeAvatarHash({ id: "cake-1", name: "Same" })).not.toBe(
      cakeAvatarHash({ id: "cake-2", name: "Same" }),
    );
  });

  it("is never empty, so the avatar always has something to hash", () => {
    expect(cakeAvatarHash({ id: "cake-1", name: "" }).length).toBeGreaterThan(0);
  });
});
