import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_RENDERER_HOST,
  FORK_SLUG,
  UPSTREAM_SLUG,
  desktopRendererOrigins,
  desktopScheme,
} from "./desktopIdentity.ts";

/**
 * The regression these cover actually happened: the fork renamed the desktop
 * scheme, the server's CORS allowlist still held upstream's, and every request
 * the renderer made was refused at the preflight. The app started, drew its
 * window, and could not reach its own backend — which reads as a dead server
 * rather than a naming mistake, so it cost far more to find than to fix.
 */

describe("desktopScheme", () => {
  it("never claims upstream's scheme", () => {
    expect(desktopScheme(false)).not.toBe(UPSTREAM_SLUG);
    expect(desktopScheme(true)).not.toBe(`${UPSTREAM_SLUG}-dev`);
  });

  it("derives both modes from the one fork slug", () => {
    expect(desktopScheme(false)).toBe(FORK_SLUG);
    expect(desktopScheme(true)).toBe(`${FORK_SLUG}-dev`);
  });

  it("keeps production and dev distinct, so one cannot answer for the other", () => {
    expect(desktopScheme(true)).not.toBe(desktopScheme(false));
  });
});

describe("desktopRendererOrigins", () => {
  /**
   * The exact invariant that broke. Whatever scheme the renderer loads under
   * must appear in the list the server allows, or the preflight fails and no
   * request from the app ever reaches a handler.
   */
  it("contains the origin the dev renderer actually presents", () => {
    expect(desktopRendererOrigins()).toContain(`${desktopScheme(true)}://${DESKTOP_RENDERER_HOST}`);
  });

  it("contains the origin the production renderer actually presents", () => {
    expect(desktopRendererOrigins()).toContain(
      `${desktopScheme(false)}://${DESKTOP_RENDERER_HOST}`,
    );
  });

  /**
   * Allowing upstream's origin would let a T3 Code renderer talk to the fork's
   * backend, which is the cross-talk the whole fork rename exists to prevent.
   */
  it("does not allow upstream's renderer to reach this backend", () => {
    const origins = desktopRendererOrigins();
    expect(origins).not.toContain(`${UPSTREAM_SLUG}://${DESKTOP_RENDERER_HOST}`);
    expect(origins).not.toContain(`${UPSTREAM_SLUG}-dev://${DESKTOP_RENDERER_HOST}`);
  });

  it("lists an origin per mode and nothing else", () => {
    expect(desktopRendererOrigins()).toHaveLength(2);
  });
});
