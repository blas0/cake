import { describe, expect, it } from "vite-plus/test";

import {
  defaultEffortOptionId,
  reconcileEffort,
  resolveEffortOptions,
  type EffortOption,
} from "./CakeFormDialog.logic.ts";

/**
 * Which effort a cake starts on, and falls back to.
 *
 * A provider declares one of its effort options the default with `isDefault`;
 * `packages/shared/src/model.ts` honours that flag everywhere else in the app.
 * The cake path dropped it in `resolveEffortOptions` and took `options[0]`
 * instead, so a provider whose default is not listed first produced cakes
 * quietly configured to something its owner never chose — and the form showed
 * that value as though it had been picked on purpose.
 */

const descriptors = (
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) => [{ id: "effort", type: "select" as const, label: "Effort", options }];

const LADDER = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium", isDefault: true },
  { id: "high", label: "High" },
];

describe("resolving a provider's effort ladder", () => {
  it("carries the declared default through", () => {
    const options = resolveEffortOptions(descriptors(LADDER));

    expect(options.find((option) => option.isDefault)?.id).toBe("medium");
  });

  it("keeps every option in the order the provider listed them", () => {
    expect(resolveEffortOptions(descriptors(LADDER)).map((o) => o.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("the effort a new cake starts on", () => {
  /** The whole point: not the first option, the declared one. */
  it("is the declared default, not the first in the list", () => {
    expect(defaultEffortOptionId(resolveEffortOptions(descriptors(LADDER)))).toBe("medium");
  });

  /**
   * A provider that declares nothing still has to yield something, and first is
   * the only defensible guess.
   */
  it("falls back to the first option when nothing is declared", () => {
    const undeclared: ReadonlyArray<EffortOption> = [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ];

    expect(defaultEffortOptionId(undeclared)).toBe("low");
  });

  /** A model with no ladder defers to the provider, which is the empty string. */
  it("is empty when the model has no effort ladder at all", () => {
    expect(defaultEffortOptionId([])).toBe("");
  });
});

describe("reconciling an effort after the model changes", () => {
  it("keeps an effort the new model still offers", () => {
    expect(reconcileEffort("high", resolveEffortOptions(descriptors(LADDER)))).toBe("high");
  });

  /**
   * The same bug one step later: an effort the new model has never heard of fell
   * back to `options[0]` rather than to what the provider declared.
   */
  it("falls back to the declared default, not the first option", () => {
    expect(reconcileEffort("xxl", resolveEffortOptions(descriptors(LADDER)))).toBe("medium");
  });

  it("yields empty when the new model has no ladder", () => {
    expect(reconcileEffort("high", [])).toBe("");
  });
});
