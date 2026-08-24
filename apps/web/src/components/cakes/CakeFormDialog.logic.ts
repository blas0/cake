import {
  CAKE_MINIMUM_INTERVAL_MESSAGE,
  CakeId,
  cakeToolEnforcementReason,
  defaultCakeSchedule,
  isCakeIntervalTooShort,
  ProviderDriverKind,
  to12Hour,
  to24Hour,
  type CakeAnchorCadence,
  type CakeConfig,
  type CakeInput,
  type CakeIntervalUnit,
  type CakeMeridiem,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";

/**
 * Every decision the cake form makes, made away from the markup.
 *
 * The form is the only place a user states what an unattended loop will do for
 * the next several months, so the interesting parts are the refusals: what the
 * picker must not offer, what must not be stored because it was never shown,
 * and what the user must be told will not be honoured. Those live here, where
 * they can be tested, rather than inside conditional JSX.
 */

export type Meridiem = CakeMeridiem;

/**
 * A schedule is one of two shapes, and this is which one the form is editing.
 *
 * `every` is the CLI form the user already knows — `/loop <prompt> 19m` — and
 * `at` is the calendar form. They share no fields, which is exactly why the
 * mode is a choice rather than a set of controls that grey each other out.
 */
export type CakeScheduleMode = "every" | "at";

/**
 * The form's own state. It is deliberately not `CakeConfig`: it holds the
 * fields of *both* modes at once, so switching mode to look at the other one
 * and switching back does not lose what was typed. `cakeDraftToInput` is where
 * that convenience is reduced to the one arm the server should actually store.
 */
export interface CakeDraft {
  readonly id: string;
  readonly name: string;
  readonly providerKind: string;
  readonly model: string;
  readonly effort: string;
  readonly scheduleMode: CakeScheduleMode;
  readonly intervalCount: number;
  readonly intervalUnit: CakeIntervalUnit;
  readonly anchorCadence: CakeAnchorCadence;
  readonly hour12: number;
  readonly meridiem: Meridiem;
  readonly timeZone: string;
  readonly disallowedTools: ReadonlyArray<string>;
  readonly instructions: string;
}

export interface CakeScheduleFields {
  readonly showInterval: boolean;
  readonly showTimeOfDay: boolean;
}

/**
 * Which schedule controls a mode actually has.
 *
 * An interval cake has no time of day — it fires on a grid counted from a fixed
 * origin, and a 9 AM shown beside it would be a time the cake never runs at.
 * An anchored cake has no count. Neither field is "ignored" in the other mode;
 * it does not exist there.
 */
export function cakeScheduleFields(mode: CakeScheduleMode): CakeScheduleFields {
  return { showInterval: mode === "every", showTimeOfDay: mode === "at" };
}

export { to12Hour, to24Hour };

/**
 * The zone the user is actually in.
 *
 * Resolved from the running system every time rather than stored or guessed. A
 * hardcoded zone is right for exactly the developer who wrote it, and wrong
 * silently: the cake simply runs at the wrong hour for everyone else.
 */
export function resolveSystemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export interface ToolEnforcementNote {
  readonly enforced: boolean;
  readonly note: string;
}

/**
 * What to say next to the disallowed-tool list for a given provider.
 *
 * The unenforceable reason comes from the contract rather than being restated
 * here, so the form cannot drift into claiming an enforcement the server does
 * not perform. A user who believes a tool is off while it runs unattended at
 * full permission is the failure this note exists to prevent.
 */
export function toolEnforcementNote(providerKind: string): ToolEnforcementNote {
  // No provider can honour a list, so there is no enforced branch to take. The
  // note is the contract's own reason rather than a string restated here, so
  // the form cannot drift into claiming an enforcement the server never does.
  return { enforced: false, note: cakeToolEnforcementReason(providerKind) };
}

/** Tool names as typed: comma- or newline-separated, trimmed, de-duplicated. */
export function parseToolList(value: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const tools: Array<string> = [];
  for (const raw of value.split(/[,\n]/)) {
    const tool = raw.trim();
    if (tool.length === 0 || seen.has(tool)) continue;
    seen.add(tool);
    tools.push(tool);
  }
  return tools;
}

export function formatToolList(tools: ReadonlyArray<string>): string {
  return tools.join(", ");
}

export interface EffortOption {
  readonly id: string;
  readonly label: string;
  /**
   * Carried through from the provider's descriptor rather than dropped.
   *
   * It used to be discarded here, which left every caller taking `options[0]`.
   * A provider whose default is not listed first then produced cakes quietly
   * set to something nobody chose, with the form displaying that value as if it
   * had been picked on purpose.
   */
  readonly isDefault?: boolean | undefined;
}

/**
 * Descriptor ids that mean "how hard should the model think".
 *
 * Each provider names it differently and the list is open, so the form matches
 * on any of them rather than assuming one provider's vocabulary. Mirrors the
 * set the provider settings panel already recognises.
 */
const EFFORT_DESCRIPTOR_IDS = new Set(["reasoningEffort", "effort", "reasoning", "variant"]);

export function resolveEffortOptions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined | null,
): ReadonlyArray<EffortOption> {
  const descriptor = descriptors?.find(
    (candidate) => candidate.type === "select" && EFFORT_DESCRIPTOR_IDS.has(candidate.id),
  );
  if (descriptor === undefined || descriptor.type !== "select") return [];
  return descriptor.options.map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.isDefault === undefined ? {} : { isDefault: option.isDefault }),
  }));
}

/**
 * The effort a cake should start on, given a model's ladder.
 *
 * `find(isDefault)` is the convention the rest of the app already follows
 * (`packages/shared/src/model.ts`), and first-in-list is the fallback for a
 * provider that declares nothing. An empty ladder yields the empty string,
 * which is how a cake says "use whatever this provider defaults to".
 */
export function defaultEffortOptionId(options: ReadonlyArray<EffortOption>): string {
  return (options.find((option) => option.isDefault) ?? options[0])?.id ?? "";
}

/**
 * Keep an effort that still exists, otherwise take the model's default.
 *
 * Changing model must not leave a cake carrying an effort the new model has
 * never heard of — the provider would either reject the turn or quietly ignore
 * it, and the form would still be showing the old value as if it applied.
 */
export function reconcileEffort(current: string, options: ReadonlyArray<EffortOption>): string {
  if (options.length === 0) return "";
  if (options.some((option) => option.id === current)) return current;
  return defaultEffortOptionId(options);
}

export type CakeDraftField = "name" | "model" | "instructions" | "hour" | "intervalCount";

export type CakeDraftErrors = Readonly<Partial<Record<CakeDraftField, string>>>;

export function cakeDraftErrors(cake: CakeDraft): CakeDraftErrors {
  const errors: Partial<Record<CakeDraftField, string>> = {};
  const fields = cakeScheduleFields(cake.scheduleMode);

  if (cake.name.trim().length === 0) errors.name = "Give the cake a name.";
  if (cake.model.trim().length === 0) errors.model = "Choose a model.";
  if (cake.instructions.trim().length === 0) {
    errors.instructions = "CAKE.md is the prompt every run sends, so it cannot be empty.";
  }

  // Shown rather than clamped. Silently rounding `every 1 second` up to a
  // minute would leave the user believing a cadence the scheduler is not
  // running, which is the failure the floor exists to prevent in the first
  // place — just moved from the machine to the person.
  if (fields.showInterval && isCakeIntervalTooShort(cake.intervalCount, cake.intervalUnit)) {
    errors.intervalCount = CAKE_MINIMUM_INTERVAL_MESSAGE;
  }

  if (fields.showTimeOfDay) {
    if (!Number.isInteger(cake.hour12) || cake.hour12 < 1 || cake.hour12 > 12) {
      errors.hour = "Hour must be between 1 and 12.";
    }
  }

  return errors;
}

export function canSubmitCakeDraft(cake: CakeDraft): boolean {
  return Object.keys(cakeDraftErrors(cake)).length === 0;
}

/**
 * Which fields the user has already had a chance to be wrong about.
 *
 * A brand-new draft is empty, so it is invalid, so `cakeDraftErrors` has plenty
 * to say about it the instant the dialog opens — and a form that greets the user
 * in red for not yet having typed reads as already broken. The errors are still
 * computed from the first render, because the submit button has to know; what
 * this records is the separate question of whether the user has been given the
 * opportunity to make each mistake yet.
 *
 * Leaving a field is not that opportunity on its own. Name is the first field
 * in the dialog, so clicking anywhere else — including into the very field you
 * meant to fill in next — used to blur it and accuse you of not having named a
 * cake you were in the middle of writing. Being told off for a field you have
 * not reached yet is the same failure as being told off on the first render,
 * arriving a second later.
 *
 * So a field earns its message by being **changed and then left**: you have had
 * a go at it and moved on, which is the point at which "that is not valid" is
 * news rather than nagging. Every field earns it at once the moment a submit is
 * attempted — there the user has said they are finished, and silence about what
 * is missing would be the worse failure.
 */
export interface CakeFormTouch {
  /** Blurred after being edited — the fields allowed to show a message. */
  readonly fields: ReadonlyArray<CakeDraftField>;
  /**
   * Changed at least once, whether or not left yet.
   *
   * Kept apart from `fields` because editing alone must not accuse: a message
   * appearing between keystrokes is the same nagging one field earlier.
   */
  readonly edited: ReadonlyArray<CakeDraftField>;
  readonly submitAttempted: boolean;
}

export const UNTOUCHED_CAKE_FORM: CakeFormTouch = {
  fields: [],
  edited: [],
  submitAttempted: false,
};

/** Records a change. Silent by itself; it is what lets a later blur speak. */
export function editCakeField(touch: CakeFormTouch, field: CakeDraftField): CakeFormTouch {
  if (touch.edited.includes(field)) return touch;
  return { ...touch, edited: [...touch.edited, field] };
}

/**
 * Records a blur, which only counts for a field the user has actually touched.
 *
 * A blur on an untouched field is someone passing through, not someone
 * finishing.
 */
export function touchCakeField(touch: CakeFormTouch, field: CakeDraftField): CakeFormTouch {
  if (!touch.edited.includes(field)) return touch;
  if (touch.fields.includes(field)) return touch;
  return { ...touch, fields: [...touch.fields, field] };
}

export function touchCakeSubmit(touch: CakeFormTouch): CakeFormTouch {
  return touch.submitAttempted ? touch : { ...touch, submitAttempted: true };
}

/**
 * The subset of `cakeDraftErrors` the form is allowed to show yet.
 *
 * This is the only thing the markup should ask: both the message and the red
 * `aria-invalid` border are driven from it, so the two can never disagree about
 * whether a field is being accused.
 */
export function shownCakeDraftErrors(cake: CakeDraft, touch: CakeFormTouch): CakeDraftErrors {
  const errors = cakeDraftErrors(cake);
  if (touch.submitAttempted) return errors;

  const shown: Partial<Record<CakeDraftField, string>> = {};
  for (const field of touch.fields) {
    const message = errors[field];
    if (message !== undefined) shown[field] = message;
  }
  return shown;
}

/**
 * Reduce the draft to what the server should store.
 *
 * Two reductions matter. Only the fields of the chosen mode cross the wire, so
 * the record matches what the user was actually shown rather than what the
 * other half of the form still held. And a disallowed-tool list is dropped on
 * any provider that cannot honour it, because a stored list is one a later
 * screen can display as if it applied.
 */
export function cakeDraftToInput(cake: CakeDraft): CakeInput {
  const usesTools = toolEnforcementNote(cake.providerKind).enforced;

  return {
    id: CakeId.make(cake.id),
    name: cake.name.trim(),
    providerKind: ProviderDriverKind.make(cake.providerKind),
    model: cake.model.trim(),
    effort: cake.effort,
    schedule:
      cake.scheduleMode === "every"
        ? { kind: "every", count: cake.intervalCount, unit: cake.intervalUnit }
        : {
            kind: "at",
            cadence: cake.anchorCadence,
            hour: cake.hour12,
            meridiem: cake.meridiem,
            timeZone: cake.timeZone,
          },
    disallowedTools: usesTools ? cake.disallowedTools : [],
    instructions: cake.instructions.trim(),
  };
}

/**
 * What the mode the user is *not* editing starts out holding.
 *
 * A draft carries both modes, so opening a stored interval cake still has to
 * put something in the anchored fields. These are the values a fresh cake would
 * have had, which keeps switching mode a look rather than a surprise.
 */
const IDLE_INTERVAL: {
  readonly intervalCount: number;
  readonly intervalUnit: CakeIntervalUnit;
} = { intervalCount: 1, intervalUnit: "hour" };

const IDLE_ANCHOR: {
  readonly anchorCadence: CakeAnchorCadence;
  readonly hour12: number;
  readonly meridiem: Meridiem;
} = { anchorCadence: "day", hour12: 9, meridiem: "AM" };

export function cakeToDraft(cake: CakeConfig, fallbackTimeZone: string): CakeDraft {
  const schedule = cake.schedule;
  const shared = {
    id: cake.id,
    name: cake.name,
    providerKind: cake.providerKind,
    model: cake.model,
    effort: cake.effort,
    disallowedTools: cake.disallowedTools,
    instructions: cake.instructions,
  };

  return schedule.kind === "every"
    ? {
        ...shared,
        ...IDLE_ANCHOR,
        scheduleMode: "every",
        intervalCount: schedule.count,
        intervalUnit: schedule.unit,
        // An interval schedule stores no zone, because it never asks what the
        // wall clock says. The form still needs one to show if the user
        // switches to the anchored mode.
        timeZone: fallbackTimeZone,
      }
    : {
        ...shared,
        ...IDLE_INTERVAL,
        scheduleMode: "at",
        anchorCadence: schedule.cadence,
        hour12: schedule.hour,
        meridiem: schedule.meridiem,
        timeZone: schedule.timeZone.trim() || fallbackTimeZone,
      };
}

export function newCakeDraft(seed: {
  readonly id: string;
  readonly timeZone: string;
  readonly providerKind: string;
  readonly model: string;
  readonly effort: string;
}): CakeDraft {
  const schedule = defaultCakeSchedule(seed.timeZone);
  return {
    id: seed.id,
    name: "",
    providerKind: seed.providerKind,
    model: seed.model,
    effort: seed.effort,
    ...IDLE_INTERVAL,
    ...IDLE_ANCHOR,
    scheduleMode: schedule.kind === "every" ? "every" : "at",
    ...(schedule.kind === "every"
      ? { intervalCount: schedule.count, intervalUnit: schedule.unit }
      : {
          anchorCadence: schedule.cadence,
          hour12: schedule.hour,
          meridiem: schedule.meridiem,
        }),
    timeZone: seed.timeZone,
    disallowedTools: [],
    instructions: "",
  };
}
