import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { CakeAnchoredSchedule, CakeSchedule } from "./cakeSchedule.ts";
import { CakeConfig, CakeId, cakeToolEnforcementReason, defaultCakeSchedule } from "./cakes.ts";

/**
 * The cake config is what the user fills in once and the scheduler then obeys
 * unattended, for months. Every assertion below is a decision that was made
 * explicitly and would otherwise be re-litigated by whoever touches this next.
 */

const decodeCake = Schema.decodeUnknownSync(CakeConfig);
const decodeCakeId = Schema.decodeUnknownSync(CakeId);

const validCake = {
  id: "cake_01HQZX",
  name: "Nightly triage",
  providerKind: "claudeAgent",
  model: "claude-opus-5",
  effort: "high",
  schedule: {
    kind: "at",
    cadence: "day",
    hour: 9,
    meridiem: "AM",
    timeZone: "America/New_York",
  },
  disallowedTools: ["Bash"],
  instructions: "# CAKE.md\n\nTriage the inbox.",
};

describe("CakeId", () => {
  it("trims and accepts a bounded identifier", () => {
    expect(decodeCakeId("  cake_01  ")).toBe("cake_01");
  });

  it("rejects an empty identifier", () => {
    expect(() => decodeCakeId("   ")).toThrow();
  });
});

describe("CakeConfig", () => {
  it("accepts a fully specified cake", () => {
    const cake = decodeCake(validCake);
    expect(cake.name).toBe("Nightly triage");
    expect(cake.schedule.kind).toBe("at");
  });

  /**
   * A cake with no instructions has nothing to run. The loop prompt is the
   * whole payload of every scheduled invocation, so an empty CAKE.md would
   * spawn an agent with an empty turn, on a timer, forever.
   */
  it("rejects a cake with blank instructions", () => {
    expect(() => decodeCake({ ...validCake, instructions: "   " })).toThrow();
  });

  it("rejects a cake with a blank name", () => {
    expect(() => decodeCake({ ...validCake, name: "  " })).toThrow();
  });

  /**
   * Cakes run unattended at full permission by deliberate decision, so there is
   * no permission field to get wrong. Asserting its absence keeps someone from
   * quietly adding one and creating a second source of truth alongside the
   * thread's own runtime-mode control.
   */
  it("carries no permission field", () => {
    const cake = decodeCake(validCake);
    expect("permissionMode" in cake).toBe(false);
    expect("runtimeMode" in cake).toBe(false);
  });

  it("defaults an omitted disallowed-tool list to empty", () => {
    const { disallowedTools: _omitted, ...withoutTools } = validCake;
    expect(decodeCake(withoutTools).disallowedTools).toEqual([]);
  });

  /**
   * Session fork used to live here as a stored boolean. It is gone rather than
   * defaulted: a stored field the schema still accepts is one the form can
   * still render and the repository can still write, which is how a control
   * whose promise the system cannot keep gets back on screen.
   *
   * Where a run happens is now derived at run time from the attached thread —
   * see `decideCakeRunTarget` on the server.
   */
  it("does not carry a session-fork switch", () => {
    const cake = decodeCake({ ...validCake, sessionFork: false });
    expect("sessionFork" in cake).toBe(false);
  });
});

/**
 * Narrowed rather than asserted through `as`: the interval arm of the union
 * genuinely has no timezone, so a test that reached for one would be checking a
 * field that cannot exist rather than failing honestly.
 */
function anchored(schedule: CakeSchedule): CakeAnchoredSchedule {
  if (schedule.kind !== "at") {
    throw new Error(`expected an anchored schedule, got ${schedule.kind}`);
  }
  return schedule;
}

describe("defaultCakeSchedule", () => {
  it("starts as a daily anchored schedule in the caller's timezone", () => {
    const schedule = anchored(defaultCakeSchedule("Europe/Berlin"));
    expect(schedule.cadence).toBe("day");
    expect(schedule.hour).toBe(9);
    expect(schedule.meridiem).toBe("AM");
    expect(schedule.timeZone).toBe("Europe/Berlin");
  });

  it("never hardcodes a timezone of its own", () => {
    expect(anchored(defaultCakeSchedule("Asia/Tokyo")).timeZone).toBe("Asia/Tokyo");
    expect(anchored(defaultCakeSchedule("UTC")).timeZone).toBe("UTC");
  });
});

/**
 * The disallowed-tool list means something different on each provider, and the
 * form has to say so rather than implying a guarantee it cannot keep. This is
 * the repo's own rule: every provider-shaped feature gets a per-adapter
 * decision, even when that decision is "not supported here".
 */
describe("cakeToolEnforcementReason", () => {
  /**
   * Corrected a second time, and for a different reason than the ACP
   * providers. Claude's SDK does take a `disallowedTools` option — that part
   * was right — but it reads it once, when the session's `query()` is created,
   * and the live handle offers no way to change it afterwards. A cake shares
   * its thread's session with the person who types in that thread, so the only
   * way to apply a cake's list is to apply it to their turns too.
   *
   * The list is therefore not honoured anywhere today, and this asserts the
   * form is told so. Re-adding an enforced policy without first giving the list a
   * route to the adapter re-introduces the exact lie the type exists to
   * prevent: a tool the user believes is off, running unattended at full
   * permission.
   */
  it("is unenforceable for Claude, because a session's tool list is not a cake's to set", () => {
    expect(cakeToolEnforcementReason("claudeAgent")).toContain("session");
  });

  /**
   * Corrected after reading the adapters: ACP decides tools through
   * `session/request_permission`, and a cake runs at full permission, so that
   * request is never raised. An earlier version of this file claimed
   * deny-at-request worked here, which would have told the user a tool was off
   * while it ran.
   */
  it("is unenforceable for the ACP providers, because full permission never asks", () => {
    for (const provider of ["cursor", "grok"] as const) {
      expect(cakeToolEnforcementReason(provider)).toContain("permission");
    }
  });

  /**
   * No provider honours the list today. This is the assertion that has to fail
   * the day someone wires one up — at which point the form starts enabling the
   * field again, and that had better be deliberate rather than incidental.
   */
  it("gives every mechanism its own reason, and none of them a promise", () => {
    const reasons = ["claudeAgent", "codex", "cursor", "grok"].map(cakeToolEnforcementReason);

    for (const reason of reasons) expect(reason.length).toBeGreaterThan(0);

    // Three mechanisms, not four providers: Cursor and Grok are both ACP and
    // fail for one reason, so they share a sentence on purpose. Asserting four
    // distinct strings would be asserting a distinction that does not exist.
    expect(new Set(reasons).size).toBe(3);
    expect(cakeToolEnforcementReason("cursor")).toBe(cakeToolEnforcementReason("grok"));
  });

  /**
   * Codex exposes an approval policy, not a tool list, and a cake runs with
   * approvals off — so there is no point at which a named tool can be refused.
   * Saying so in the form is the honest option; silently accepting the list and
   * ignoring it is the one that gets someone hurt.
   */
  it("is unenforceable for Codex, and says why", () => {
    expect(cakeToolEnforcementReason("codex")).toContain("approval");
  });

  it("describes every provider a cake can run on", () => {
    for (const provider of ["claudeAgent", "codex", "cursor", "grok"] as const) {
      expect(cakeToolEnforcementReason(provider).length).toBeGreaterThan(0);
    }
  });
});
