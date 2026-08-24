import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { CAKE_MINIMUM_INTERVAL_MESSAGE, cakeToolEnforcementReason } from "@t3tools/contracts";

import { AVAILABLE_PROVIDER_OPTIONS } from "../chat/providerIconUtils";
import { CakeDeleteConfirmation } from "./CakeDeleteConfirmation";
import { CakeForm } from "./CakeForm";
import {
  cakeDraftToInput,
  newCakeDraft,
  canSubmitCakeDraft,
  editCakeField,
  touchCakeField,
  touchCakeSubmit,
  UNTOUCHED_CAKE_FORM,
  type CakeDraft,
  type CakeDraftField,
  type CakeFormTouch,
} from "./CakeFormDialog.logic";

/**
 * The create-a-cake form, rendered.
 *
 * `CakeFormDialog.logic.test.ts` already proves every decision this form makes.
 * What it cannot prove is that any of those decisions reach the screen: a mode
 * whose controls are never drawn, a refusal computed and then not shown, a
 * field left editable that the server will ignore. Those are wiring failures,
 * and they are invisible to a logic test by construction — so everything below
 * asserts against markup, through labels and visible words rather than
 * structure, and never re-derives what the logic module already owns.
 *
 * A Base UI select keeps its option list in a portal, so a rendered select
 * shows its *current* value and its accessible name and nothing else. Every
 * assertion here is therefore about which controls exist, what they read, and
 * whether they are usable — which is exactly the layer the logic tests miss.
 */

const draftOf = (overrides: Partial<CakeDraft>): CakeDraft => ({
  ...newCakeDraft({
    id: "cake-1",
    timeZone: "America/New_York",
    providerKind: "codex",
    model: "gpt-5-codex",
    effort: "",
  }),
  name: "Nightly triage",
  instructions: "Check the open pull requests.",
  ...overrides,
});

/**
 * A form nobody has touched yet, which is what a freshly opened dialog is.
 *
 * Every render below states its own touch, because "has the user had a chance
 * to be wrong about this field" is now half of what the form draws — and it is
 * a blur, which no static render can perform. `visited` and `afterSubmit` are
 * the two ways a field earns its message.
 */
/**
 * Fields the user has had a go at and moved on from — the pair that earns a
 * message. Blurring alone no longer does: leaving a field you never touched is
 * someone passing through, and accusing there is how an unnamed cake used to
 * be reported before the user had reached the name box.
 */
const visited = (...fields: ReadonlyArray<CakeDraftField>): CakeFormTouch =>
  fields.reduce(
    (touch, field) => touchCakeField(editCakeField(touch, field), field),
    UNTOUCHED_CAKE_FORM,
  );

/** Left without ever being edited. */
const passedThrough = (...fields: ReadonlyArray<CakeDraftField>): CakeFormTouch =>
  fields.reduce(touchCakeField, UNTOUCHED_CAKE_FORM);

const afterSubmit = touchCakeSubmit(UNTOUCHED_CAKE_FORM);

const render = (
  draft: CakeDraft,
  mode: "create" | "edit" = "create",
  touch: CakeFormTouch = afterSubmit,
) =>
  renderToStaticMarkup(
    <CakeForm
      mode={mode}
      draft={draft}
      onDraftChange={() => undefined}
      onCancel={() => undefined}
      onSubmit={() => undefined}
      onDelete={() => undefined}
      isSaving={false}
      initialTouch={touch}
    />,
  );

/** Every control a screen reader could name, which is the only way an icon-free select is identified. */
const accessibleNames = (markup: string): ReadonlyArray<string> =>
  [...markup.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1] ?? "");

/** What a person reads, with the markup taken out from between the words. */
const visibleText = (markup: string): string =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const openingTagFor = (markup: string, id: string): string => {
  const at = markup.indexOf(`id="${id}"`);
  if (at === -1) return "";
  return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
};

const fieldValue = (markup: string, id: string): string | null => {
  const tag = openingTagFor(markup, id);
  return /value="([^"]*)"/.exec(tag)?.[1] ?? null;
};

const fieldIsDisabled = (markup: string, id: string): boolean =>
  openingTagFor(markup, id).includes("disabled=");

/** The button whose face reads `label`, and whether it can be pressed. */
const buttonIsDisabled = (markup: string, label: string): boolean => {
  const at = markup.indexOf(`>${label}<`);
  if (at === -1) throw new Error(`no button reading "${label}"`);
  return markup.slice(markup.lastIndexOf("<button", at), at).includes("disabled=");
};

/**
 * Whether the form would refuse to save this draft.
 *
 * Asked of the draft rather than read off a disabled button, because the save
 * button is no longer disabled by an invalid draft: pressing it is how the user
 * finds out what is missing. The refusal moved into the press handler, so this
 * is where it has to be checked.
 */
const wouldRefuse = (draft: CakeDraft): boolean => !canSubmitCakeDraft(draft);

describe("the cake form's schedule field", () => {
  it("draws a count and a unit in the interval mode, and no clock", () => {
    const names = accessibleNames(
      render(draftOf({ scheduleMode: "every", intervalCount: 6, intervalUnit: "hour" })),
    );

    expect(names).toContain("Interval count");
    expect(names).toContain("Interval unit");
    expect(names).not.toContain("Cadence");
    expect(names).not.toContain("Hour");
    expect(names).not.toContain("AM or PM");
  });

  it("draws a cadence and a clock in the anchored mode, and no count", () => {
    const names = accessibleNames(
      render(draftOf({ scheduleMode: "at", anchorCadence: "week", hour12: 9, meridiem: "AM" })),
    );

    expect(names).toContain("Cadence");
    expect(names).toContain("Hour");
    expect(names).toContain("AM or PM");
    expect(names).not.toContain("Interval count");
    expect(names).not.toContain("Interval unit");
  });

  it("states the unit the count is counting, in words", () => {
    const markup = render(
      draftOf({ scheduleMode: "every", intervalCount: 6, intervalUnit: "hour" }),
    );

    expect(fieldValue(markup, "cake-interval-count")).toBe("6");
    expect(visibleText(markup)).toContain("hours");
  });

  it("reads back the hour the anchored mode was given", () => {
    const text = visibleText(
      render(draftOf({ scheduleMode: "at", anchorCadence: "week", hour12: 7, meridiem: "PM" })),
    );

    expect(text).toContain("week");
    expect(text).toContain("7");
    expect(text).toContain("PM");
  });

  /** An interval fires on a grid counted from a fixed origin, so a wall clock beside it would be a lie. */
  it("names the timezone only where a time of day exists", () => {
    const anchored = visibleText(render(draftOf({ scheduleMode: "at" })));
    const interval = visibleText(render(draftOf({ scheduleMode: "every" })));

    expect(anchored).toContain("America/New_York");
    expect(interval).not.toContain("America/New_York");
  });

  /**
   * The draft holds both modes at once so that looking at the other one is a
   * look rather than a loss. The logic test proves the draft keeps both halves;
   * this proves the form re-draws the half it was holding, which is where that
   * guarantee would actually be spent.
   */
  it("still shows the interval it was given after a look at the anchored mode and back", () => {
    const typed = draftOf({ scheduleMode: "every", intervalCount: 6, intervalUnit: "hour" });
    const looking: CakeDraft = { ...typed, scheduleMode: "at" };
    const back: CakeDraft = { ...looking, scheduleMode: "every" };

    const away = render(looking);
    expect(accessibleNames(away)).not.toContain("Interval count");
    expect(visibleText(away)).toContain("9");

    const returned = render(back);
    expect(fieldValue(returned, "cake-interval-count")).toBe("6");
    expect(visibleText(returned)).toContain("hours");
  });

  it("keeps the anchored hour through the same trip in the other direction", () => {
    const typed = draftOf({
      scheduleMode: "at",
      anchorCadence: "month",
      hour12: 7,
      meridiem: "PM",
    });
    const looking: CakeDraft = { ...typed, scheduleMode: "every" };
    const back: CakeDraft = { ...looking, scheduleMode: "at" };

    expect(visibleText(render(looking))).not.toContain("PM");

    const returned = visibleText(render(back));
    expect(returned).toContain("PM");
    expect(returned).toContain("month");
  });
});

describe("the cake form's refusals", () => {
  /**
   * Shown rather than clamped, and shown in the contract's own words: a user who
   * asked for thirty seconds and was silently given sixty is exactly the person
   * the floor exists to protect.
   */
  it("says why thirty seconds is not a schedule, in the contract's words", () => {
    const markup = render(
      draftOf({ scheduleMode: "every", intervalCount: 30, intervalUnit: "second" }),
      "create",
      visited("intervalCount"),
    );

    expect(visibleText(markup)).toContain(CAKE_MINIMUM_INTERVAL_MESSAGE);
    expect(
      wouldRefuse(draftOf({ scheduleMode: "every", intervalCount: 30, intervalUnit: "second" })),
    ).toBe(true);
  });

  it("stops saying it once the interval clears the floor", () => {
    const markup = render(
      draftOf({ scheduleMode: "every", intervalCount: 2, intervalUnit: "minute" }),
      "create",
      visited("intervalCount"),
    );

    expect(visibleText(markup)).not.toContain(CAKE_MINIMUM_INTERVAL_MESSAGE);
    expect(
      wouldRefuse(draftOf({ scheduleMode: "every", intervalCount: 2, intervalUnit: "minute" })),
    ).toBe(false);
  });

  it("refuses an unnamed cake, and says which field is missing once the name has been left", () => {
    const markup = render(draftOf({ name: "" }), "create", visited("name"));

    expect(visibleText(markup)).toContain("Give the cake a name.");
    expect(markup).toContain('aria-invalid="true"');
    expect(wouldRefuse(draftOf({ name: "" }))).toBe(true);
  });

  it("refuses an empty CAKE.md once it has been left, since it is the prompt every run sends", () => {
    const markup = render(draftOf({ instructions: "   " }), "create", visited("instructions"));

    expect(visibleText(markup)).toContain("CAKE.md is the prompt every run sends");
    expect(markup).toContain('aria-invalid="true"');
    expect(wouldRefuse(draftOf({ instructions: "   " }))).toBe(true);
  });

  it("says all of it at once when a save is attempted, whatever was visited", () => {
    const markup = render(draftOf({ name: "", instructions: "" }), "create", afterSubmit);
    const text = visibleText(markup);

    expect(text).toContain("Give the cake a name.");
    expect(text).toContain("CAKE.md is the prompt every run sends");
  });
});

/**
 * A form is not an accusation.
 *
 * A new cake starts empty, so it is invalid, so every message this form owns is
 * true about it before the user has typed a character. Saying so on open is a
 * dialog that greets its user in red for a mistake they have not had the chance
 * to make yet — and once red means "this is just what the form looks like", it
 * has stopped meaning anything on the day it is deserved. The refusal is still
 * real: the button below stays dead. It is only the telling-off that waits.
 */
describe("the cake form's silence before the user has spoken", () => {
  it("accuses a freshly opened form of nothing at all", () => {
    const markup = render(
      newCakeDraft({
        id: "cake-1",
        timeZone: "America/New_York",
        providerKind: "codex",
        model: "gpt-5-codex",
        effort: "",
      }),
      "create",
      UNTOUCHED_CAKE_FORM,
    );
    const text = visibleText(markup);

    expect(text).not.toContain("Give the cake a name.");
    expect(text).not.toContain("CAKE.md is the prompt every run sends");
    expect(text).not.toContain("Choose a model.");
    expect(markup).not.toContain('aria-invalid="true"');
  });

  /**
   * The whole point of waiting: an empty form still cannot be saved, and the
   * button that refuses is still pressable — that press is what turns the
   * silence into an explanation.
   */
  it("still refuses to save the form it is saying nothing about", () => {
    const markup = render(draftOf({ name: "", instructions: "" }), "create", UNTOUCHED_CAKE_FORM);

    expect(wouldRefuse(draftOf({ name: "", instructions: "" }))).toBe(true);
    expect(buttonIsDisabled(markup, "Create Cake")).toBe(false);
  });

  /**
   * The reported bug: name is the first field, so clicking anywhere at all —
   * including into the field you meant to fill in next — blurred it and
   * accused you of not naming a cake you were still writing.
   */
  it("does not ask for a name just because the user clicked elsewhere", () => {
    const markup = render(draftOf({ name: "", instructions: "" }), "create", passedThrough("name"));

    expect(visibleText(markup)).not.toContain("Give the cake a name.");
    expect(markup).not.toContain('aria-invalid="true"');
  });

  /** It is still asked for the moment the user says they are finished. */
  it("asks for a name as soon as a save is attempted without one", () => {
    const markup = render(draftOf({ name: "", instructions: "" }), "create", afterSubmit);

    expect(visibleText(markup)).toContain("Give the cake a name.");
  });

  it("keeps quiet about the fields the user has not reached yet", () => {
    const markup = render(draftOf({ name: "", instructions: "" }), "create", visited("name"));
    const text = visibleText(markup);

    expect(text).toContain("Give the cake a name.");
    expect(text).not.toContain("CAKE.md is the prompt every run sends");
  });

  /** A visited field that is fine is still a field with nothing to say. */
  it("says nothing about a field that was visited and left valid", () => {
    const markup = render(draftOf({}), "create", visited("name", "instructions"));
    const text = visibleText(markup);

    expect(text).not.toContain("Give the cake a name.");
    expect(text).not.toContain("CAKE.md is the prompt every run sends");
    expect(wouldRefuse(draftOf({}))).toBe(false);
  });
});

describe("the cake form's submission", () => {
  it("offers to create an interval cake, and would send the interval on screen", () => {
    const draft = draftOf({ scheduleMode: "every", intervalCount: 6, intervalUnit: "hour" });
    const markup = render(draft);

    expect(buttonIsDisabled(markup, "Create Cake")).toBe(false);
    expect(fieldValue(markup, "cake-interval-count")).toBe("6");
    expect(visibleText(markup)).toContain("hours");
    expect(cakeDraftToInput(draft).schedule).toEqual({ kind: "every", count: 6, unit: "hour" });
  });

  it("offers to create an anchored cake, and would send the time on screen", () => {
    const draft = draftOf({
      scheduleMode: "at",
      anchorCadence: "week",
      hour12: 7,
      meridiem: "PM",
    });
    const markup = render(draft);
    const text = visibleText(markup);

    expect(buttonIsDisabled(markup, "Create Cake")).toBe(false);
    expect(text).toContain("week");
    expect(text).toContain("PM");
    expect(cakeDraftToInput(draft).schedule).toEqual({
      kind: "at",
      cadence: "week",
      hour: 7,
      meridiem: "PM",
      timeZone: "America/New_York",
    });
  });

  it("titles its own button by what pressing it does", () => {
    expect(visibleText(render(draftOf({}), "create"))).toContain("Create Cake");

    const editing = visibleText(render(draftOf({}), "edit"));
    expect(editing).toContain("Save changes");
    expect(editing).toContain("Delete");
  });

  it("offers no way to delete a cake that does not exist yet", () => {
    expect(visibleText(render(draftOf({}), "create"))).not.toContain("Delete");
  });

  it("focuses the name when Rename opens the editor", () => {
    const markup = renderToStaticMarkup(
      <CakeForm
        mode="edit"
        draft={draftOf({})}
        onDraftChange={() => undefined}
        onCancel={() => undefined}
        onSubmit={() => undefined}
        onDelete={() => undefined}
        isSaving={false}
        autoFocusName
      />,
    );

    expect(openingTagFor(markup, "cake-name")).toContain("autofocus");
  });

  it("asks before deleting from the shelf editor", () => {
    const markup = renderToStaticMarkup(
      <CakeDeleteConfirmation
        cakeName="Nightly triage"
        isSaving={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(visibleText(markup)).toContain('Delete "Nightly triage"?');
    expect(visibleText(markup)).toContain("Keep cake");
    expect(visibleText(markup)).toContain("Delete cake");
  });
});

/**
 * No provider can honour a disallowed-tool list, and a cake runs unattended at
 * full permission. A field that looks typeable is a user believing a tool is
 * off while it runs — so the field must be dead on every harness offered, and
 * must say why in that harness's own terms.
 */
describe("the cake form's disallowed-tool field", () => {
  for (const provider of AVAILABLE_PROVIDER_OPTIONS) {
    it(`is dead, with its reason showing, on ${provider.label}`, () => {
      const markup = render(draftOf({ providerKind: provider.value }));

      expect(fieldIsDisabled(markup, "cake-disallowed-tools")).toBe(true);
      expect(visibleText(markup)).toContain(cakeToolEnforcementReason(provider.value));
    });
  }

  it("offers at least one harness to check that against", () => {
    expect(AVAILABLE_PROVIDER_OPTIONS.length).toBeGreaterThan(0);
  });

  /**
   * The reason is an explanation, not a refusal. Nothing the user can type will
   * change it and nothing is being asked of them, so it must not wear the
   * colour this form reserves for "you have to fix this" — otherwise red stops
   * meaning anything by the time a field genuinely earns it.
   */
  it("explains itself in the muted voice the form's other hints use", () => {
    const markup = render(draftOf({}), "create", UNTOUCHED_CAKE_FORM);

    expect(visibleText(markup)).toContain(cakeToolEnforcementReason("codex"));
    expect(markup).not.toContain("text-destructive-foreground");
  });

  it("looks as inert as it is", () => {
    const markup = render(draftOf({}), "create", UNTOUCHED_CAKE_FORM);

    expect(fieldIsDisabled(markup, "cake-disallowed-tools")).toBe(true);
    expect(markup).toContain("cursor-not-allowed");
    // A placeholder is an invitation to type into a field that cannot be typed into.
    expect(markup).not.toContain("Bash, WebFetch");
  });
});

/**
 * The session-fork switch is gone, and must stay gone.
 *
 * It promised the user a choice about whether a loop remembered its own prior
 * runs, and offered that choice as the answer to a problem it could not reach:
 * a thread whose provider refuses a mid-conversation model change refuses the
 * cake's turn whatever the session does. Where a run happens is derived at run
 * time now. A control back on this screen would be a promise the system cannot
 * keep, which is the only reason this asserts an absence.
 */
describe("the cake form's session handling", () => {
  it("offers no session-fork control", () => {
    const markup = render(draftOf({}));

    expect(accessibleNames(markup)).not.toContain("Session fork");
    expect(markup).not.toContain('id="cake-session-fork"');
    expect(visibleText(markup)).not.toContain("Session fork");
  });
});
