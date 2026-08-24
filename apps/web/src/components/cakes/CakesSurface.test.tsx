import { Children, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { RightPanelTabs } from "../RightPanelTabs";
import { CakeShelfActionMenuItems, CakeShelfActionTriggerButton } from "./CakeShelfItemActions";
import { CakeShelfDragRow } from "./CakeShelfDragRow";

/**
 * Adding a right-panel surface means touching several registries that do not
 * reference each other. The typecheck catches the exhaustive switches; nothing
 * catches an entry missing from the launcher's `actions` array or from the add
 * menu, because those are plain arrays of JSX. This renders both and looks.
 */

const cakesSurface = { id: "cakes" as const, kind: "cakes" as const };

const baseProps = {
  mode: "inline" as const,
  pendingSurfaceIds: new Set<string>(),
  previewSessions: {},
  desktopByTabId: {},
  terminalLabelsById: new Map<string, string>(),
  onActivate: () => undefined,
  onCloseSurface: () => undefined,
  onCloseOtherSurfaces: () => undefined,
  onCloseSurfacesToRight: () => undefined,
  onCloseAllSurfaces: () => undefined,
  onCopyFilePath: () => undefined,
  onAddBrowser: () => undefined,
  onAddTerminal: () => undefined,
  onAddPullRequest: () => undefined,
  onAddDiff: () => undefined,
  onAddFiles: () => undefined,
  onAddAgents: () => undefined,
  onAddCakes: () => undefined,
  liveAgentCount: 0,
  browserAvailable: false,
  terminalAvailable: false,
  diffAvailable: false,
  filesAvailable: false,
  pullRequestAvailable: false,
  agentsAvailable: false,
};

describe("the Cakes right-panel surface", () => {
  it("offers a Cakes card in the launcher when a thread can take one", () => {
    const markup = renderToStaticMarkup(
      <RightPanelTabs {...baseProps} surfaces={[]} activeSurfaceId={null} cakesAvailable>
        <div>content</div>
      </RightPanelTabs>,
    );

    expect(markup).toContain("Cakes");
    expect(markup).toContain("Drag a saved agent loop onto this thread.");
  });

  /**
   * Every other launcher letter is taken; C has to reach the card, and it has
   * to be listed in the launcher's own key manifest or the global handler
   * never sees it.
   */
  it("claims the C shortcut for it", () => {
    const markup = renderToStaticMarkup(
      <RightPanelTabs {...baseProps} surfaces={[]} activeSurfaceId={null} cakesAvailable>
        <div>content</div>
      </RightPanelTabs>,
    );

    expect(markup).toContain('data-surface-launcher-keys="C"');
  });

  it("shows the unavailability hint instead of a dead card off a thread", () => {
    const markup = renderToStaticMarkup(
      <RightPanelTabs {...baseProps} surfaces={[]} activeSurfaceId={null}>
        <div>content</div>
      </RightPanelTabs>,
    );

    expect(markup).toContain("Available from a thread.");
  });

  it("titles the open tab Cakes", () => {
    const markup = renderToStaticMarkup(
      <RightPanelTabs
        {...baseProps}
        surfaces={[cakesSurface]}
        activeSurfaceId={cakesSurface.id}
        cakesAvailable
      >
        <div>content</div>
      </RightPanelTabs>,
    );

    expect(markup).toContain("Close Cakes");
  });
});

/**
 * The shelf is a palette you drag from, not a control surface.
 *
 * Run now, Stop and the lock moved to the composer's cake picker, which is the
 * only place that knows which thread the instruction lands in. Asserting their
 * absence here is what stops them drifting back: a row that grew a button again
 * would silently offer to run a cake against no particular thread.
 */
describe("a cake row on the right panel's shelf", () => {
  const row = (
    <CakeShelfDragRow
      cakeId="cake-1"
      name="Nightly triage"
      driverKind={ProviderDriverKind.make("claudeAgent")}
      providerLabel="Claude Code"
      modelLabel="Opus 4.5"
      effortLabel="Medium"
      avatar={<span role="img" aria-label="Nightly triage" />}
      onDragStart={() => undefined}
      onRename={() => undefined}
      onEdit={() => undefined}
      onDelete={() => undefined}
    />
  );

  it("says enough to know what you are picking up", () => {
    const markup = renderToStaticMarkup(row);

    expect(markup).toContain("Nightly triage");
    expect(markup).toContain("draggable");
  });

  /**
   * The second line is the configuration: what this cake runs on, and how hard.
   * Written as one string rather than two elements so the brackets can be
   * dropped along with the effort.
   */
  it("writes the model and its effort under the name", () => {
    expect(renderToStaticMarkup(row)).toContain("Opus 4.5 (Medium)");
  });

  /** A model with no effort ladder should not be followed by empty brackets. */
  it("drops the brackets when the model has no effort ladder", () => {
    const markup = renderToStaticMarkup(
      <CakeShelfDragRow
        cakeId="cake-1"
        name="Nightly triage"
        driverKind={ProviderDriverKind.make("claudeAgent")}
        providerLabel="Claude Code"
        modelLabel="Opus 4.5"
        effortLabel=""
        avatar={<span role="img" aria-label="Nightly triage" />}
        onDragStart={() => undefined}
        onRename={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(markup).toContain("Opus 4.5");
    expect(markup).not.toContain("Opus 4.5 (");
  });

  /**
   * Provider mark, then name, on the top line. The mark is an `aria-hidden`
   * svg with no text of its own, so the check is positional — and the name is
   * matched as a text node, because the avatar's `aria-label` carries the same
   * string and sits ahead of everything.
   */
  it("puts the provider's mark before the cake's name", () => {
    const markup = renderToStaticMarkup(row);
    const icon = markup.indexOf("<svg");

    expect(icon).toBeGreaterThan(-1);
    expect(icon).toBeLessThan(markup.indexOf(">Nightly triage<"));
  });

  it("offers no Run, Stop or lock control", () => {
    const markup = renderToStaticMarkup(row);

    expect(markup).not.toContain('aria-label="Run Nightly triage now"');
    expect(markup).not.toContain('aria-label="Stop Nightly triage"');
    expect(markup).not.toContain('aria-label="Disable Nightly triage"');
    expect(markup).not.toContain('aria-label="Enable Nightly triage"');
  });

  it("offers Rename, Edit and Delete by name", () => {
    const menu = CakeShelfActionMenuItems({
      onRename: () => undefined,
      onEdit: () => undefined,
      onDelete: () => undefined,
    });
    const labels = Children.toArray(menu.props.children).map(
      (child) => (child as ReactElement<{ children: ReactNode }>).props.children,
    );

    expect(labels).toEqual(["Rename", "Edit", "Delete"]);
    const markup = renderToStaticMarkup(row);
    const labelAt = markup.indexOf('aria-label="Actions for Nightly triage"');
    const button = markup.slice(
      markup.lastIndexOf("<button", labelAt),
      markup.indexOf("</button>"),
    );
    expect(labelAt).toBeGreaterThan(-1);
    expect(button).toContain("<svg");
  });

  it("does not let the ellipsis press start a drag", () => {
    const stopPropagation = vi.fn();
    const trigger = CakeShelfActionTriggerButton({ cakeName: "Nightly triage" });
    const onPointerDown = (
      trigger.props as { onPointerDown: (event: { stopPropagation(): void }) => void }
    ).onPointerDown;

    onPointerDown({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("stays draggable with the menu present", () => {
    const markup = renderToStaticMarkup(row);

    expect(markup).toContain("draggable");
    expect(markup).toContain('aria-label="Actions for Nightly triage"');
  });

  it("promises no next run, having no thread to promise it for", () => {
    const markup = renderToStaticMarkup(row);

    expect(markup).not.toContain("Next run:");
  });
});
