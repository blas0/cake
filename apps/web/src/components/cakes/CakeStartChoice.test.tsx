import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { CakeStartChoice, CakeStartQuestion } from "./CakeStartChoice.tsx";

describe("the confirmation offered when a cake lands on an unstarted thread", () => {
  it("names the cake and draws its face", () => {
    const markup = renderToStaticMarkup(
      <CakeStartQuestion
        cakeName="Nightly triage"
        avatar={<span role="img" aria-label="Nightly triage" />}
      />,
    );

    expect(markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain(
      "Start Nightly triage now?",
    );
    expect(markup).toContain('aria-label="Nightly triage"');
  });

  it("offers exactly one way to say yes", () => {
    const markup = renderToStaticMarkup(<CakeStartChoice onStart={() => undefined} />);

    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain(">Start now<");
  });

  it("starts only when its button is pressed", () => {
    const onStart = vi.fn();
    const choice = CakeStartChoice({ onStart });

    expect(onStart).not.toHaveBeenCalled();
    choice.props.onClick();
    expect(onStart).toHaveBeenCalledOnce();
  });
});
