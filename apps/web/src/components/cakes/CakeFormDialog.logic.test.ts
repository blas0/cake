import {
  CakeId,
  ProviderDriverKind,
  type CakeConfig,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cakeDraftErrors,
  cakeDraftToInput,
  cakeScheduleFields,
  cakeToDraft,
  canSubmitCakeDraft,
  formatToolList,
  newCakeDraft,
  parseToolList,
  reconcileEffort,
  resolveEffortOptions,
  resolveSystemTimeZone,
  shownCakeDraftErrors,
  to12Hour,
  to24Hour,
  toolEnforcementNote,
  editCakeField,
  touchCakeField,
  type CakeDraftField,
  type CakeFormTouch,
  touchCakeSubmit,
  UNTOUCHED_CAKE_FORM,
  type CakeDraft,
} from "./CakeFormDialog.logic";

const ZONE = "America/New_York";

function draft(overrides: Partial<CakeDraft> = {}): CakeDraft {
  return {
    ...newCakeDraft({
      id: "cake_1",
      timeZone: ZONE,
      providerKind: "claudeAgent",
      model: "claude-sonnet-5",
      effort: "high",
    }),
    name: "Nightly",
    ...overrides,
  };
}

describe("cakeScheduleFields", () => {
  /**
   * An interval cake has no time of day. It fires on a grid counted from a
   * fixed origin, so a 9 AM shown beside it would be a time the cake never runs
   * at — not a setting it ignores, a setting it does not have.
   */
  it("shows only the count for an interval schedule", () => {
    expect(cakeScheduleFields("every")).toEqual({ showInterval: true, showTimeOfDay: false });
  });

  it("shows only the time of day for an anchored schedule", () => {
    expect(cakeScheduleFields("at")).toEqual({ showInterval: false, showTimeOfDay: true });
  });
});

describe("12-hour conversion", () => {
  it("maps midnight to 12 AM and noon to 12 PM", () => {
    expect(to12Hour(0)).toEqual({ hour12: 12, meridiem: "AM" });
    expect(to12Hour(12)).toEqual({ hour12: 12, meridiem: "PM" });
  });

  it("maps morning and afternoon hours to their clock face", () => {
    expect(to12Hour(9)).toEqual({ hour12: 9, meridiem: "AM" });
    expect(to12Hour(23)).toEqual({ hour12: 11, meridiem: "PM" });
  });

  it("round-trips every hour of the day", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const { hour12, meridiem } = to12Hour(hour);
      expect(to24Hour(hour12, meridiem)).toBe(hour);
    }
  });

  it("sends 12 AM back to 0 and 12 PM back to 12", () => {
    expect(to24Hour(12, "AM")).toBe(0);
    expect(to24Hour(12, "PM")).toBe(12);
  });
});

describe("resolveSystemTimeZone", () => {
  it("resolves the running system zone rather than a baked-in literal", () => {
    const resolved = resolveSystemTimeZone();
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("toolEnforcementNote", () => {
  /**
   * Claude used to be the exception here. It is not any more: its SDK reads the
   * tool list once, when the session's `query()` is created, and a cake shares
   * that session with the person typing in the same thread. The form must show
   * the disabled, explained field rather than an enabled one that stores a list
   * nothing reads.
   */
  it("tells the truth about Claude, which cannot honour a cake's list either", () => {
    const note = toolEnforcementNote("claudeAgent");
    expect(note.enforced).toBe(false);
    expect(note.note.length).toBeGreaterThan(0);
  });

  it("passes through the contract's own reason for a provider that cannot enforce", () => {
    for (const provider of ["claudeAgent", "codex", "cursor", "grok"]) {
      const note = toolEnforcementNote(provider);
      expect(note.enforced).toBe(false);
      expect(note.note.length).toBeGreaterThan(0);
    }
  });

  it("says a tool list does nothing on an unknown provider instead of implying it does", () => {
    const note = toolEnforcementNote("someFutureDriver");
    expect(note.enforced).toBe(false);
    expect(note.note).toContain("someFutureDriver");
  });
});

describe("parseToolList", () => {
  it("splits on commas and newlines, trims, and drops blanks", () => {
    expect(parseToolList(" Bash, Write \n\n Edit ,")).toEqual(["Bash", "Write", "Edit"]);
  });

  it("keeps the first spelling of a repeated tool and drops the rest", () => {
    expect(parseToolList("Bash, Bash, Edit")).toEqual(["Bash", "Edit"]);
  });

  it("returns nothing for an empty field", () => {
    expect(parseToolList("   ")).toEqual([]);
  });

  it("round-trips through the rendered value", () => {
    const tools = ["Bash", "WebFetch"];
    expect(parseToolList(formatToolList(tools))).toEqual(tools);
  });
});

describe("resolveEffortOptions", () => {
  const effortDescriptor: ProviderOptionDescriptor = {
    id: "reasoningEffort",
    label: "Reasoning effort",
    type: "select",
    options: [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ],
  };

  it("finds the effort select among a model's descriptors", () => {
    expect(resolveEffortOptions([effortDescriptor])).toEqual([
      { id: "low", label: "Low" },
      // `isDefault` is carried through now. Dropping it here was the whole
      // defect: every caller then had to guess, and guessed `[0]`.
      { id: "high", label: "High", isDefault: true },
    ]);
  });

  it("returns nothing when the model exposes no effort control", () => {
    expect(resolveEffortOptions([{ id: "fastMode", label: "Fast mode", type: "boolean" }])).toEqual(
      [],
    );
    expect(resolveEffortOptions(undefined)).toEqual([]);
  });

  it("keeps a still-valid effort when the model changes", () => {
    expect(reconcileEffort("low", resolveEffortOptions([effortDescriptor]))).toBe("low");
  });

  /**
   * This test already carried the right name and the wrong assertion: the
   * descriptor above declares `high` as its default, and it expected `low` —
   * the first in the list. The name described the intended behaviour while the
   * assertion pinned the bug in place.
   */
  it("falls back to the descriptor default when the current effort is gone", () => {
    expect(reconcileEffort("xhigh", resolveEffortOptions([effortDescriptor]))).toBe("high");
  });

  it("clears the effort entirely when the new model has none", () => {
    expect(reconcileEffort("high", [])).toBe("");
  });
});

describe("cakeDraftErrors", () => {
  it("accepts a complete draft", () => {
    expect(cakeDraftErrors(draft({ instructions: "Do the thing." }))).toEqual({});
    expect(canSubmitCakeDraft(draft({ instructions: "Do the thing." }))).toBe(true);
  });

  it("requires a name, a model and instructions", () => {
    const errors = cakeDraftErrors(draft({ name: "  ", model: "", instructions: "\n" }));
    expect(errors.name).toBeDefined();
    expect(errors.model).toBeDefined();
    expect(errors.instructions).toBeDefined();
    expect(canSubmitCakeDraft(draft({ name: "  " }))).toBe(false);
  });

  it("rejects an hour off the clock face", () => {
    expect(cakeDraftErrors(draft({ hour12: 0, instructions: "x" })).hour).toBeDefined();
    expect(cakeDraftErrors(draft({ hour12: 13, instructions: "x" })).hour).toBeDefined();
  });

  it("ignores the time of day for an interval cake, which has none to get wrong", () => {
    const errors = cakeDraftErrors(draft({ scheduleMode: "every", hour12: 99, instructions: "x" }));
    expect(errors.hour).toBeUndefined();
  });

  /**
   * Shown as a refusal rather than clamped in silence. A cake spawns a
   * full-access agent unattended and the scheduler ticks every 30 seconds, so
   * a sub-minute interval is a cadence the machine will never run — quietly
   * rounding it up would leave the user believing the number they typed.
   */
  it("refuses an interval under a minute and says why", () => {
    const tooShort = cakeDraftErrors(
      draft({
        scheduleMode: "every",
        intervalCount: 59,
        intervalUnit: "second",
        instructions: "x",
      }),
    );
    expect(tooShort.intervalCount).toBeDefined();
    expect(tooShort.intervalCount).toContain("60 seconds");
    expect(
      canSubmitCakeDraft(
        draft({
          scheduleMode: "every",
          intervalCount: 59,
          intervalUnit: "second",
          instructions: "x",
        }),
      ),
    ).toBe(false);
  });

  it("accepts exactly the floor, and any count above it", () => {
    expect(
      cakeDraftErrors(
        draft({
          scheduleMode: "every",
          intervalCount: 60,
          intervalUnit: "second",
          instructions: "x",
        }),
      ).intervalCount,
    ).toBeUndefined();
    expect(
      cakeDraftErrors(
        draft({
          scheduleMode: "every",
          intervalCount: 19,
          intervalUnit: "minute",
          instructions: "x",
        }),
      ).intervalCount,
    ).toBeUndefined();
  });

  it("refuses a count that is not a whole number of periods", () => {
    for (const intervalCount of [0, -1, 2.5]) {
      expect(
        cakeDraftErrors(
          draft({ scheduleMode: "every", intervalCount, intervalUnit: "hour", instructions: "x" }),
        ).intervalCount,
      ).toBeDefined();
    }
  });

  it("ignores the interval count entirely on an anchored cake", () => {
    expect(
      cakeDraftErrors(draft({ scheduleMode: "at", intervalCount: 0, instructions: "x" }))
        .intervalCount,
    ).toBeUndefined();
  });
});

/**
 * What is wrong and what may be said are two different questions.
 *
 * `cakeDraftErrors` answers the first for the submit button, which has to know
 * from the first render. This answers the second for the markup: a message is
 * earned by the user having had the opportunity to make that particular
 * mistake, so an untouched draft is invalid *and* silent.
 */
describe("shownCakeDraftErrors", () => {
  const empty = draft({ name: "", instructions: "" });

  it("says nothing about a draft nobody has touched", () => {
    expect(shownCakeDraftErrors(empty, UNTOUCHED_CAKE_FORM)).toEqual({});
  });

  /** Silence is not approval — the refusal it is staying quiet about is still on. */
  it("leaves the refusal itself untouched", () => {
    expect(canSubmitCakeDraft(empty)).toBe(false);
    expect(cakeDraftErrors(empty).name).toBeDefined();
  });

  /** Edited, then left. That pair is what earns a message. */
  const left = (touch: CakeFormTouch, field: CakeDraftField): CakeFormTouch =>
    touchCakeField(editCakeField(touch, field), field);

  /**
   * The reported bug. Name is the first field in the dialog, so clicking
   * anywhere — including into the field you meant to fill in next — blurs it.
   * Accusing there is being told off for a field you have not reached yet.
   */
  it("stays quiet when a field is left without ever being edited", () => {
    expect(shownCakeDraftErrors(empty, touchCakeField(UNTOUCHED_CAKE_FORM, "name"))).toEqual({});
  });

  /** Editing alone is just as quiet, or the message arrives between keystrokes. */
  it("stays quiet while a field is being edited", () => {
    expect(shownCakeDraftErrors(empty, editCakeField(UNTOUCHED_CAKE_FORM, "name"))).toEqual({});
  });

  it("says only what the field the user actually tried is wrong about", () => {
    const shown = shownCakeDraftErrors(empty, left(UNTOUCHED_CAKE_FORM, "name"));

    expect(shown.name).toBe(cakeDraftErrors(empty).name);
    expect(shown.instructions).toBeUndefined();
  });

  it("accumulates fields as they are tried and left", () => {
    const shown = shownCakeDraftErrors(
      empty,
      left(left(UNTOUCHED_CAKE_FORM, "name"), "instructions"),
    );

    expect(shown.name).toBeDefined();
    expect(shown.instructions).toBeDefined();
  });

  it("counts a field only once however often it is left", () => {
    const once = left(UNTOUCHED_CAKE_FORM, "name");

    expect(touchCakeField(once, "name")).toBe(once);
    expect(once.fields).toEqual(["name"]);
  });

  it("records an edit only once", () => {
    const once = editCakeField(UNTOUCHED_CAKE_FORM, "name");

    expect(editCakeField(once, "name")).toBe(once);
    expect(once.edited).toEqual(["name"]);
  });

  /** At submit the user has said they are finished, so withholding is the worse failure. */
  it("says everything once a save was attempted, tried or not", () => {
    expect(shownCakeDraftErrors(empty, touchCakeSubmit(UNTOUCHED_CAKE_FORM))).toEqual(
      cakeDraftErrors(empty),
    );
  });

  it("has nothing to show for a field that is fine", () => {
    const good = draft({ instructions: "x" });

    expect(shownCakeDraftErrors(good, touchCakeSubmit(UNTOUCHED_CAKE_FORM))).toEqual({});
  });
});

describe("cakeDraftToInput", () => {
  it("submits the anchored fields as the clock face the user picked", () => {
    const input = cakeDraftToInput(
      draft({
        scheduleMode: "at",
        anchorCadence: "week",
        hour12: 7,
        meridiem: "PM",
        instructions: "x",
      }),
    );
    expect(input.schedule).toEqual({
      kind: "at",
      cadence: "week",
      hour: 7,
      meridiem: "PM",
      timeZone: ZONE,
    });
  });

  /**
   * The mode the user is not editing must not cross the wire. A draft carries
   * both, so a submitted schedule that leaked the other one would store a
   * cadence the form never showed.
   */
  it("submits only the mode that was chosen", () => {
    const input = cakeDraftToInput(
      draft({
        scheduleMode: "every",
        intervalCount: 19,
        intervalUnit: "minute",
        hour12: 7,
        meridiem: "PM",
        instructions: "x",
      }),
    );
    expect(input.schedule).toEqual({ kind: "every", count: 19, unit: "minute" });
  });

  it("trims the free-text fields the server stores as non-empty strings", () => {
    const input = cakeDraftToInput(draft({ name: "  Nightly  ", instructions: "  Do it.  " }));
    expect(input.name).toBe("Nightly");
    expect(input.instructions).toBe("Do it.");
  });

  /**
   * Every provider is currently in this case, Claude included. Storing a list
   * nothing enforces would let a later screen render it back as if it applied,
   * which is the same lie one layer further from the check.
   */
  it("drops the disallowed-tool list on a provider that cannot enforce it", () => {
    for (const providerKind of ["claudeAgent", "codex", "cursor", "grok"]) {
      const input = cakeDraftToInput(
        draft({ providerKind, disallowedTools: ["Bash"], instructions: "x" }),
      );
      expect(input.disallowedTools).toEqual([]);
    }
  });
});

describe("cakeToDraft", () => {
  const stored: CakeConfig = {
    id: CakeId.make("cake_7"),
    name: "Nightly",
    providerKind: ProviderDriverKind.make("claudeAgent"),
    model: "claude-sonnet-5",
    effort: "high",
    schedule: { kind: "at", cadence: "month", hour: 12, meridiem: "AM", timeZone: ZONE },
    disallowedTools: ["Bash"],
    instructions: "Do it.",
  };

  it("opens a stored anchored schedule in the anchored mode", () => {
    const editing = cakeToDraft(stored, "UTC");
    expect(editing.scheduleMode).toBe("at");
    expect(editing.anchorCadence).toBe("month");
    expect(editing.hour12).toBe(12);
    expect(editing.meridiem).toBe("AM");
    expect(editing.timeZone).toBe(ZONE);
  });

  /**
   * An interval schedule stores no zone, because it never asks what the wall
   * clock says. The form still needs one to show if the user switches mode, so
   * it falls back to the system zone rather than to a blank.
   */
  it("opens a stored interval schedule in the interval mode", () => {
    const interval: CakeConfig = {
      ...stored,
      schedule: { kind: "every", count: 19, unit: "minute" },
    };
    const editing = cakeToDraft(interval, "UTC");
    expect(editing.scheduleMode).toBe("every");
    expect(editing.intervalCount).toBe(19);
    expect(editing.intervalUnit).toBe("minute");
    expect(editing.timeZone).toBe("UTC");
  });

  it("round-trips a stored cake through the form without changing it", () => {
    const input = cakeDraftToInput(cakeToDraft(stored, "UTC"));
    expect(input.schedule).toEqual(stored.schedule);
    expect(input.name).toBe(stored.name);
  });

  /**
   * The one field that deliberately does not survive the trip. Cakes saved
   * while Claude was believed to enforce a list still have one in the database;
   * re-saving such a cake clears it rather than carrying a list nothing reads
   * back out into storage.
   */
  it("clears a tool list stored before any provider could enforce one", () => {
    expect(stored.disallowedTools).toEqual(["Bash"]);
    expect(cakeDraftToInput(cakeToDraft(stored, "UTC")).disallowedTools).toEqual([]);
  });

  it("falls back to the system zone for a cake stored without one", () => {
    const zoneless: CakeConfig = {
      ...stored,
      schedule: { kind: "at", cadence: "month", hour: 12, meridiem: "AM", timeZone: "" },
    };
    expect(cakeToDraft(zoneless, "UTC").timeZone).toBe("UTC");
  });
});

describe("newCakeDraft", () => {
  it("starts from the contract's default schedule in the caller's own zone", () => {
    const fresh = newCakeDraft({
      id: "cake_2",
      timeZone: ZONE,
      providerKind: "codex",
      model: "gpt-5.6-sol",
      effort: "",
    });
    expect(fresh.timeZone).toBe(ZONE);
    expect(fresh.scheduleMode).toBe("at");
    expect(fresh.anchorCadence).toBe("day");
    expect(fresh.hour12).toBe(9);
    expect(fresh.meridiem).toBe("AM");
    expect(fresh.disallowedTools).toEqual([]);
  });
});
