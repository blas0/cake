import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CakeCreateIconButton } from "./CakeCreateIconButton";
import { CakeShelfEmptyState } from "./CakeShelfEmptyState";

/**
 * One action, two faces, chosen by whether the shelf has anything on it.
 *
 * Empty, the panel's job is to explain itself, so the button is a sentence's
 * worth of words under the sentence. Once cakes exist, making another is
 * housekeeping, so it becomes an icon in the row of panel controls. Getting
 * either of those backwards is invisible to a typecheck and to every other test
 * in this directory, which is why both are pinned here.
 */

const noop = () => undefined;

describe("the shelf's empty state", () => {
  const markup = renderToStaticMarkup(<CakeShelfEmptyState onCreate={noop} canCreate />);

  it("offers to create a cake in words", () => {
    expect(markup).toContain(">Create a Cake<");
  });

  /**
   * The button's own icon, specifically — the empty state's cake glyph above it
   * is the illustration and stays. So this looks inside the button rather than
   * at the whole block.
   */
  it("puts no icon in that button", () => {
    const at = markup.indexOf(">Create a Cake<");
    const button = markup.slice(markup.lastIndexOf("<button", at), at);

    expect(button).not.toContain("<svg");
  });

  it("cannot be pressed before there is an environment to save into", () => {
    const disabled = renderToStaticMarkup(
      <CakeShelfEmptyState onCreate={noop} canCreate={false} />,
    );
    const at = disabled.indexOf(">Create a Cake<");

    expect(disabled.slice(disabled.lastIndexOf("<button", at), at)).toContain("disabled=");
  });
});

describe("the shelf's create button, once it has cakes to sit above", () => {
  const markup = renderToStaticMarkup(<CakeCreateIconButton onCreate={noop} canCreate />);

  it("is an icon", () => {
    expect(markup).toContain("<svg");
  });

  /**
   * No visible text at all: by this point the action is housekeeping, and it
   * has to stay out of the list's way.
   */
  it("carries no visible label", () => {
    expect(markup).not.toContain(">Create a Cake<");
  });

  /** Icon-only is only affordable if the button still says what it is. */
  it("still names itself for a screen reader", () => {
    expect(markup).toContain('aria-label="Create a Cake"');
  });

  /**
   * The same filled primary as the labeled empty-shelf action. Losing the label
   * is the only difference between the two; a ghost or an outline here would
   * make one action look like two.
   */
  it("keeps the filled primary treatment of the labeled create action", () => {
    expect(markup).toContain("bg-primary");
    expect(markup).toContain("text-primary-foreground");
  });

  /**
   * The glyph has to come out white against that fill, and the button base
   * paints icons from `--control-icon-color` rather than from the text colour —
   * so without this the fill is blue and the plus is whatever the variable last
   * happened to hold. Pinning the variable rather than a colour class is what
   * makes that mistake impossible to repeat quietly.
   */
  it("lets the icon take the button's own foreground colour", () => {
    expect(markup).toContain("[--control-icon-color:currentColor]");
  });
});
