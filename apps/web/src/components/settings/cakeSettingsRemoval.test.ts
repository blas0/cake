import { describe, expect, it } from "vite-plus/test";

import { searchSettings, SETTINGS_SECTION_LABELS } from "./settingsSearch";

describe("Settings after cake management moves to the shelf", () => {
  it("has no Cakes navigation entry", () => {
    // The sidebar derives its entries from this ordered catalog.
    expect(Object.values(SETTINGS_SECTION_LABELS)).not.toContain("Cakes");
  });

  it("offers no Cakes search result", () => {
    expect(searchSettings("cake")).toEqual([]);
  });

  it("has no Cakes route", () => {
    const settingsRoutes = import.meta.glob("../../routes/settings*.tsx");

    expect(Object.keys(settingsRoutes).some((path) => path.endsWith("settings.cakes.tsx"))).toBe(
      false,
    );
  });
});
