/**
 * The desktop app's custom URL scheme, and the browser origins it produces.
 *
 * This lives in contracts rather than in the desktop app because two packages
 * have to agree on it and neither can import the other. The renderer loads from
 * `<scheme>://app`, and the server has to allow that exact string as a CORS
 * origin. When the fork renamed the scheme and only the desktop side was
 * updated, every request from the renderer was refused at the preflight — the
 * app booted, drew its window, and then could not talk to its own backend.
 *
 * A shared constant is the only thing that makes that class of bug impossible:
 * renaming the fork now moves the scheme and the allowlist together, because
 * they are the same value.
 */

/** This fork. Every name below is derived from it. */
export const FORK_SLUG = "t3code-cakefork";

/** Upstream's slug, kept so tests can assert the fork never claims it. */
export const UPSTREAM_SLUG = "t3code";

/**
 * The custom URL scheme. This is the one name that escapes the process:
 * claiming `t3code://` would hand the fork deep links meant for the real app.
 */
export function desktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? `${FORK_SLUG}-dev` : FORK_SLUG;
}

/** The host the renderer is served under; the path part of its origin. */
export const DESKTOP_RENDERER_HOST = "app";

/**
 * Every origin the desktop renderer can present, production and dev.
 *
 * Derived rather than written out, so the allowlist cannot drift from the
 * scheme the renderer actually loads under.
 */
export function desktopRendererOrigins(): ReadonlyArray<string> {
  return [
    `${desktopScheme(false)}://${DESKTOP_RENDERER_HOST}`,
    `${desktopScheme(true)}://${DESKTOP_RENDERER_HOST}`,
  ];
}
