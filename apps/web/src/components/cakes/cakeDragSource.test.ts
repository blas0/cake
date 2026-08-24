import { describe, expect, it } from "vite-plus/test";

import { CAKE_DRAG_TYPE } from "./cakeDrag.ts";
import { startCakeDrag } from "./cakeDragSource.ts";

/**
 * The sending half of the cake drag, mirroring the file tree's mention drag.
 *
 * It is small on purpose: everything it writes is read back by a drop handler
 * that starts an unattended agent, so the only thing worth testing here is that
 * it never writes a payload the receiver would accept but the user did not
 * mean.
 */

interface RecordedTransfer {
  readonly written: Array<{ format: string; data: string }>;
  effectAllowed: string;
  setData(format: string, data: string): void;
}

const recordingTransfer = (): RecordedTransfer => {
  const written: Array<{ format: string; data: string }> = [];
  return {
    written,
    effectAllowed: "uninitialized",
    setData(format, data) {
      written.push({ format, data });
    },
  };
};

describe("startCakeDrag", () => {
  it("writes the cake id under the cake drag type", () => {
    const dataTransfer = recordingTransfer();

    expect(startCakeDrag({ dataTransfer }, "cake-1")).toBe(true);
    expect(dataTransfer.written).toEqual([
      { format: CAKE_DRAG_TYPE, data: JSON.stringify({ cakeId: "cake-1" }) },
    ]);
  });

  /**
   * The receiver names "copy" as its drop effect. A source that allows only
   * "move" makes the browser cancel the drop without ever firing it, which
   * looks to the user like the drop target is broken rather than the drag.
   */
  it("allows the copy effect the drop handler names", () => {
    const dataTransfer = recordingTransfer();
    startCakeDrag({ dataTransfer }, "cake-1");
    expect(dataTransfer.effectAllowed).toBe("copy");
  });

  it("writes nothing when the drag carries no transfer", () => {
    expect(startCakeDrag({ dataTransfer: null }, "cake-1")).toBe(false);
  });

  it("refuses a blank cake id rather than writing an empty payload", () => {
    const dataTransfer = recordingTransfer();
    expect(startCakeDrag({ dataTransfer }, "   ")).toBe(false);
    expect(dataTransfer.written).toEqual([]);
  });
});
