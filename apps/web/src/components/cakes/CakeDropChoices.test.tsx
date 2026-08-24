import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CakeDropChoices } from "./CakeDropChoices.tsx";

/**
 * Dropping a cake on a busy thread is the one moment the user is told a turn
 * was already running there, and both ways out have to be readable as words.
 * `cakeDropDecision` only knows them as the strings "fork" and "stop-and-spawn";
 * nothing there says either option ever reaches the screen.
 */

const props = {
  cakeName: "Nightly triage",
  threadTitle: "Fix the flaky login test",
  avatar: <span aria-label="Nightly triage" role="img" />,
  onFork: () => undefined,
  onStopAndSpawn: () => undefined,
};

describe("the choice offered when a cake lands on a busy thread", () => {
  it("offers the forked thread in words", () => {
    const markup = renderToStaticMarkup(<CakeDropChoices {...props} />);

    expect(markup).toContain("Start a new forked thread with");
  });

  it("offers stopping the current agent in words", () => {
    const markup = renderToStaticMarkup(<CakeDropChoices {...props} />);

    expect(markup).toContain("Stop the current agent, and spawn the cake");
  });

  it("names the cake and the thread it would run in", () => {
    const markup = renderToStaticMarkup(<CakeDropChoices {...props} />);

    expect(markup).toContain("Nightly triage");
    expect(markup).toContain("Fix the flaky login test");
  });

  it("gives both choices as buttons, not decoration", () => {
    const markup = renderToStaticMarkup(<CakeDropChoices {...props} />);

    expect(markup.match(/<button/g)).toHaveLength(2);
  });

  it("draws the avatar it is handed rather than one of its own", () => {
    const markup = renderToStaticMarkup(<CakeDropChoices {...props} avatar={<em>face</em>} />);

    expect(markup).toContain("<em>face</em>");
  });
});
