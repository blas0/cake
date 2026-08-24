import { describe, expect, it } from "vite-plus/test";

import {
  CAKE_DRAG_TYPE,
  cakeIdFromTransfer,
  dataTransferHasCake,
  serializeCakeDrag,
} from "./cakeDrag.ts";

/**
 * Dropping a cake onto a thread is how a loop gets started, so the drag has to
 * be distinguishable from every other thing a user can drag into that same
 * container: OS files, file-tree mentions, plain selected text. A drop handler
 * that guesses will start an unattended agent from a stray text selection.
 */

const transfer = (types: ReadonlyArray<string>, data: Record<string, string> = {}) => ({
  types,
  getData: (format: string) => data[format] ?? "",
  dropEffect: "none",
});

describe("dataTransferHasCake", () => {
  it("recognises a cake drag by its own MIME type", () => {
    expect(dataTransferHasCake([CAKE_DRAG_TYPE])).toBe(true);
  });

  /**
   * The three things most likely to be dragged into the same container. None of
   * them may be mistaken for a cake.
   */
  it("ignores files, file mentions and plain text", () => {
    expect(dataTransferHasCake(["Files"])).toBe(false);
    expect(dataTransferHasCake(["application/x-t3code-composer-mention"])).toBe(false);
    expect(dataTransferHasCake(["text/plain"])).toBe(false);
  });

  it("recognises a cake dragged alongside other payloads", () => {
    expect(dataTransferHasCake(["text/plain", CAKE_DRAG_TYPE])).toBe(true);
  });
});

describe("cakeIdFromTransfer", () => {
  it("round-trips the cake id it was given", () => {
    const payload = serializeCakeDrag("cake-1");
    expect(cakeIdFromTransfer(transfer([CAKE_DRAG_TYPE], { [CAKE_DRAG_TYPE]: payload }))).toBe(
      "cake-1",
    );
  });

  it("returns null when the drag carries no cake", () => {
    expect(cakeIdFromTransfer(transfer(["text/plain"]))).toBeNull();
  });

  /**
   * A malformed payload must not become a cake id. Anything can write to a
   * drag transfer, and the id goes straight into a call that starts an agent.
   */
  it("returns null for a malformed payload rather than trusting it", () => {
    expect(cakeIdFromTransfer(transfer([CAKE_DRAG_TYPE], { [CAKE_DRAG_TYPE]: "" }))).toBeNull();
    expect(
      cakeIdFromTransfer(transfer([CAKE_DRAG_TYPE], { [CAKE_DRAG_TYPE]: "not json" })),
    ).toBeNull();
    expect(
      cakeIdFromTransfer(transfer([CAKE_DRAG_TYPE], { [CAKE_DRAG_TYPE]: '{"cakeId":""}' })),
    ).toBeNull();
  });
});
