import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { CakeShelfModel } from "../cakes/cakeThreadModel";
import { ComposerCakeRow } from "./ComposerCakeRow";

/**
 * The composer's picker is where a cake becomes actionable, because it is the
 * only surface that knows which thread the action lands in. These controls used
 * to sit on the right panel's shelf; that they now render here, still named, is
 * the thing worth pinning down.
 *
 * The row's two controls carry no text. That is a deliberate reduction, and it
 * is only affordable if each one still says what it is to a screen reader — so
 * the accessible name is the thing under test, not the icon.
 */

const shelf: CakeShelfModel = {
  attachments: [],
  runningCakeId: null,
  onRunNow: () => undefined,
  onStop: () => undefined,
  onSetEnabled: () => undefined,
};

/**
 * Attached and enabled with a slot ahead of it — the ordinary resting state of
 * a cake somebody has set up. `scheduled`, not `idle`: `idle` is what a cake
 * looks like once it has been switched off.
 */
const scheduled = {
  cakeId: "cake-1",
  enabled: true,
  isRunning: false,
  status: "scheduled",
  nextRunLabel: "Next run: 9:00 AM, today",
} as const;

const props = {
  name: "Nightly triage",
  driverKind: ProviderDriverKind.make("claudeAgent"),
  providerLabel: "Claude Code",
  avatar: <span role="img" aria-label="Nightly triage" />,
  shelf,
};

describe("a cake row in the composer's picker", () => {
  it("names the cake and when it next runs", () => {
    const markup = renderToStaticMarkup(<ComposerCakeRow {...props} row={scheduled} />);

    expect(markup).toContain("Nightly triage");
    expect(markup).toContain("Next run: 9:00 AM, today");
  });

  /**
   * The model was chosen when the cake was made and does not change here, so
   * repeating it on every row spends the width the cake's own name needs.
   */
  it("does not repeat the model the cake was configured with", () => {
    const markup = renderToStaticMarkup(<ComposerCakeRow {...props} row={scheduled} />);

    expect(markup).not.toContain("Opus 4.5");
  });

  /**
   * Provider first. It is the fixed part of the row — every row belongs to one
   * thread, and what differs between them is whose agent is about to run — so
   * it is what the eye should land on before the name.
   */
  it("puts the provider's mark before the cake's name", () => {
    const markup = renderToStaticMarkup(<ComposerCakeRow {...props} row={scheduled} />);

    // The mark is an `aria-hidden` SVG carrying no text of its own, so the
    // assertion is positional: the first `<svg` in the row is the provider's,
    // because the avatar arrives as a plain node here and the row's two
    // controls come after the name.
    //
    // The name is matched as a text node. Searching for the bare string finds
    // the avatar's `aria-label` first, which sits ahead of everything and would
    // make this pass or fail for the wrong reason.
    const icon = markup.indexOf("<svg");
    expect(icon).toBeGreaterThan(-1);
    expect(icon).toBeLessThan(markup.indexOf(">Nightly triage<"));
  });

  /**
   * The name is the status. A cake that is going to run without being asked
   * glimmers; one that has been switched off goes grey. Nothing else on the row
   * says which is which, so this is the whole signal.
   */
  it("glimmers the name while the cake is scheduled to run", () => {
    expect(renderToStaticMarkup(<ComposerCakeRow {...props} row={scheduled} />)).toContain(
      "cake-glimmer",
    );
  });

  it("keeps glimmering while the cake is actually running", () => {
    const running = { ...scheduled, isRunning: true, status: "active" } as const;
    expect(renderToStaticMarkup(<ComposerCakeRow {...props} row={running} />)).toContain(
      "cake-glimmer",
    );
  });

  it("greys the name once the cake is attached but switched off", () => {
    const off = { ...scheduled, enabled: false, status: "idle" } as const;
    const markup = renderToStaticMarkup(<ComposerCakeRow {...props} row={off} />);

    expect(markup).not.toContain("cake-glimmer");
    expect(markup).toContain("text-muted-foreground");
  });

  it("says so when the cake has no scheduled slot", () => {
    const markup = renderToStaticMarkup(
      <ComposerCakeRow
        {...props}
        row={{ ...scheduled, nextRunLabel: "Next run: not scheduled" }}
      />,
    );

    expect(markup).toContain("Next run: not scheduled");
  });

  it("offers Start, named, while the cake is idle", () => {
    const markup = renderToStaticMarkup(<ComposerCakeRow {...props} row={scheduled} />);

    expect(markup).toContain('aria-label="Run Nightly triage now"');
    expect(markup).not.toContain('aria-label="Stop Nightly triage"');
  });

  it("offers Stop, named, while that cake is running", () => {
    const markup = renderToStaticMarkup(
      <ComposerCakeRow {...props} row={{ ...scheduled, isRunning: true }} />,
    );

    expect(markup).toContain('aria-label="Stop Nightly triage"');
    expect(markup).not.toContain('aria-label="Run Nightly triage now"');
  });

  it("names the lock for what pressing it does to an enabled cake", () => {
    const markup = renderToStaticMarkup(<ComposerCakeRow {...props} row={scheduled} />);

    expect(markup).toContain('aria-label="Disable Nightly triage"');
  });

  it("flips that name once the cake is disabled", () => {
    const markup = renderToStaticMarkup(
      <ComposerCakeRow {...props} row={{ ...scheduled, enabled: false }} />,
    );

    expect(markup).toContain('aria-label="Enable Nightly triage"');
    expect(markup).not.toContain('aria-label="Disable Nightly triage"');
  });

  /** Icon-only means icon-only: no stray label text leaking into the row. */
  it("draws no text label on either control", () => {
    const markup = renderToStaticMarkup(<ComposerCakeRow {...props} row={scheduled} />);

    expect(markup).not.toContain(">Run<");
    expect(markup).not.toContain(">Stop<");
  });
});
