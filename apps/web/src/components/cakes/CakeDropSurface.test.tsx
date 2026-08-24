import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CAKE_DRAG_TYPE } from "./cakeDrag.ts";
import { CakeDropSurface, composeCakeDropDragProps } from "./CakeDropSurface.tsx";
import type { CakeDropEvent, CakeDropHandlers } from "./cakeDropHandlers.ts";

/**
 * The thread column is where a dragged cake lands. Whether the drop will be
 * taken is only knowable from the affordance, so its presence and absence are
 * the behaviour; the handlers behind it are `cakeDropHandlers`' business and
 * are only checked here for being reached, in the right order.
 */

const inertHandlers: CakeDropHandlers = {
  onDragEnter: () => undefined,
  onDragOver: () => undefined,
  onDragLeave: () => undefined,
  onDrop: () => undefined,
};

describe("the thread's cake drop surface", () => {
  it("says the drop will land while a cake is over it", () => {
    const markup = renderToStaticMarkup(
      <CakeDropSurface dragActive handlers={inertHandlers}>
        <p>transcript</p>
      </CakeDropSurface>,
    );

    expect(markup).toContain("Drop to run this cake on the thread");
    expect(markup).toContain('role="status"');
  });

  it("says nothing when nothing is being dragged", () => {
    const markup = renderToStaticMarkup(
      <CakeDropSurface dragActive={false} handlers={inertHandlers}>
        <p>transcript</p>
      </CakeDropSurface>,
    );

    expect(markup).not.toContain("Drop to run this cake on the thread");
    expect(markup).not.toContain('role="status"');
  });

  it("keeps drawing the thread underneath either way", () => {
    const dragging = renderToStaticMarkup(
      <CakeDropSurface dragActive handlers={inertHandlers}>
        <p>transcript</p>
      </CakeDropSurface>,
    );
    const idle = renderToStaticMarkup(
      <CakeDropSurface dragActive={false} handlers={inertHandlers}>
        <p>transcript</p>
      </CakeDropSurface>,
    );

    expect(dragging).toContain("<p>transcript</p>");
    expect(idle).toContain("<p>transcript</p>");
  });
});

describe("the surface's drag wiring", () => {
  const fakeEvent = (): CakeDropEvent => ({
    dataTransfer: {
      types: [CAKE_DRAG_TYPE],
      dropEffect: "none",
      getData: () => "",
    },
    relatedTarget: null,
    currentTarget: { contains: () => false },
    nativeEvent: { stopPropagation: () => undefined },
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  });

  const recordingHandlers = (log: string[], prefix: string): CakeDropHandlers => ({
    onDragEnter: () => log.push(`${prefix}:enter`),
    onDragOver: () => log.push(`${prefix}:over`),
    onDragLeave: () => log.push(`${prefix}:leave`),
    onDrop: () => log.push(`${prefix}:drop`),
  });

  it("hands every drag event to the cake handlers it was given", () => {
    const log: string[] = [];
    const props = composeCakeDropDragProps(recordingHandlers(log, "cake"), {});
    const event = fakeEvent();

    props.onDragEnter(event);
    props.onDragOver(event);
    props.onDragLeave(event);
    props.onDrop(event);

    expect(log).toEqual(["cake:enter", "cake:over", "cake:leave", "cake:drop"]);
  });

  /**
   * The same element also receives OS file drops. A cake drag that reached the
   * file handlers first, or that hid them, would swallow the other feature.
   */
  it("still passes the event on to the host, after the cake", () => {
    const log: string[] = [];
    const props = composeCakeDropDragProps(
      recordingHandlers(log, "cake"),
      recordingHandlers(log, "host"),
    );

    props.onDrop(fakeEvent());

    expect(log).toEqual(["cake:drop", "host:drop"]);
  });
});
