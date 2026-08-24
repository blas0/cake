// Drives the RUNNING fork app over CDP and asserts the cake surfaces a unit
// test cannot see. Run manually, never in CI: it needs a booted app.
//
//   T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT=9223 ./scripts/cake-dev.sh &
//   node scripts/cake-smoke.mjs
//
// This exists because three of this feature's worst defects — the CORS
// preflight refusing the renderer's own origin, the session-stop unlinking a
// run from its turn, and the scheduler never being started — passed every
// typecheck, lint and unit gate, and were found only by running the app. Each
// of those classes now has its own in-repo guard; this script guards the class
// itself: the composed, paired, real renderer doing the things a user does.
//
// It attaches to the app's OWN window over the debug port, inside the paired
// Electron session, so the pairing gate that blocks a plain browser never
// applies. Read-only apart from opening and closing the Create-a-Cake dialog.
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// playwright-core is in the pnpm store as a transitive dependency; resolve it
// without adding a direct dependency to any package.json.
function resolvePlaywrightCore() {
  const store = join(root, "node_modules", ".pnpm");
  const entry = readdirSync(store).find((name) => name.startsWith("playwright-core@"));
  if (!entry) throw new Error("playwright-core not found in the pnpm store");
  return createRequire(import.meta.url)(
    join(store, entry, "node_modules", "playwright-core", "index.js"),
  );
}

const CDP_PORT = process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim() || "9223";
const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const { chromium } = resolvePlaywrightCore();
const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`).catch((error) => {
  console.error(
    `Could not attach to the app on CDP port ${CDP_PORT}. Boot it with\n` +
      `  T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT=${CDP_PORT} ./scripts/cake-dev.sh\n${error}`,
  );
  process.exit(2);
});

const page = cdp
  .contexts()[0]
  .pages()
  .find((candidate) => candidate.url().includes("://app"));
if (!page) {
  console.error("No app page found over CDP — is the window open?");
  process.exit(2);
}

// 1. The renderer actually bootstrapped. The CORS defect presented as exactly
//    this: a drawn window whose root route was stuck in its error boundary.
const bootErrored = await page
  .getByText(/primary environment request failed/i)
  .first()
  .isVisible()
  .catch(() => false);
check("renderer bootstrapped (no primary-environment error on screen)", !bootErrored);

// 2. The settings surface exists and the dialog opens.
const previousUrl = page.url();
await page.evaluate(() => {
  window.location.hash = "#/settings/cakes";
});
// Wait for the route to mount rather than guessing at a duration: the
// settings route code-splits, so a fixed sleep fails on a cold chunk load and
// passes on a warm one — a flake that says nothing about the product.
const create = page.getByRole("button", { name: /create a cake/i }).first();
const createVisible = await create
  .waitFor({ state: "visible", timeout: 10_000 })
  .then(() => true)
  .catch(() => false);
check("settings/cakes renders its Create a Cake button", createVisible);

if (createVisible) {
  // A provider-update toast can be parked over the settings panel and swallows
  // the click. It is unrelated to anything under test, so it is dismissed
  // rather than worked around — leaving it up turns an ambient notification
  // into a red smoke run.
  await page.evaluate(() => {
    for (const portal of document.querySelectorAll('[data-slot="toast-portal"]')) {
      portal.remove();
    }
  });
  await create.click();
  await page.waitForTimeout(500);

  // 3. Every schedule control sits on one visual row, in both modes. This was
  //    a shipped defect (AM orphaned onto its own line) that markup-level
  //    tests could not see.
  const oneRow = async () => {
    const rows = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      const names = /schedule mode|cadence|hour|am or pm|meridiem|interval count|interval unit/i;
      const boxes = [...dialog.querySelectorAll("[aria-label], input")]
        .filter((el) => names.test(el.getAttribute("aria-label") ?? ""))
        .map((el) => el.getBoundingClientRect());
      if (boxes.length === 0) return null;
      const top = Math.min(...boxes.map((box) => box.top));
      const bottom = Math.max(...boxes.map((box) => box.bottom));
      return {
        controls: boxes.length,
        span: bottom - top,
        tallest: Math.max(...boxes.map((b) => b.height)),
      };
    });
    if (rows === null) return { ok: false, detail: "no schedule controls found" };
    // One row means the union of all boxes is no taller than the tallest box
    // (plus a couple of px of border rounding).
    return {
      ok: rows.span <= rows.tallest + 4,
      detail: `${rows.controls} controls, span ${Math.round(rows.span)}px vs control ${Math.round(rows.tallest)}px`,
    };
  };

  const anchored = await oneRow();
  check("anchored schedule controls share one row", anchored.ok, anchored.detail);

  const modeTrigger = page.getByLabel("Schedule mode");
  if (await modeTrigger.isVisible().catch(() => false)) {
    await modeTrigger.click();
    await page.waitForTimeout(250);
    await page
      .getByRole("option", { name: /run every/i })
      .click()
      .catch(() => {});
    await page.waitForTimeout(350);
    const interval = await oneRow();
    check("interval schedule controls share one row", interval.ok, interval.detail);
  } else {
    check("schedule mode control present", false);
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

// 4. The composer control reads "Cakes" — the surface a user reaches for.
//    Only meaningful on a real thread: a draft has no thread id to attach a
//    cake to, so the composer hides the control there by design.
await page.evaluate((url) => {
  window.location.href = url;
}, previousUrl);
await page.waitForTimeout(700);
const onDraft = await page.evaluate(() => window.location.hash.includes("/draft/"));
if (onDraft) {
  console.log("  skip composer Cakes control — draft thread, no thread to attach to");
} else {
  const cakesControl = await page
    .getByRole("button", { name: "Cakes" })
    .first()
    .isVisible()
    .catch(() => false);
  check("composer exposes the Cakes control on a thread", cakesControl);
}

await cdp.close();
if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nAll cake smoke checks passed against the running app.");
