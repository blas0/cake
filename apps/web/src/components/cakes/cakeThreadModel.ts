import * as DateTime from "effect/DateTime";

/**
 * What the thread surfaces know about the cakes attached to them.
 *
 * The composer's "Cakes" control, its Stop Cake button and the fork dialog's
 * title all come from here rather than from the components, because this repo
 * has no renderer test infrastructure: logic that lives in a component is
 * logic nobody can check. The components stay thin on purpose.
 */

export type CakeThreadStatus = "idle" | "scheduled" | "active";

/** One row of `cakes.listForThread`, narrowed to what the thread UI reads. */
export interface CakeAttachmentView {
  readonly cakeId: string;
  readonly enabled: boolean;
  /**
   * A decoded instant, not an ISO string.
   *
   * The contract sends `DateTimeUtc` now, so the parse happens once at the wire
   * boundary instead of here. That removed a `Date.parse` and the NaN guard
   * behind it — a guard that could only ever fire on a timestamp the server
   * itself had minted badly, and which quietly rendered "not scheduled" when it
   * did.
   */
  readonly nextRunAt: DateTime.Utc | null;
}

export interface CakeThreadEntry {
  readonly cakeId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly status: CakeThreadStatus;
}

export function deriveCakeThreadEntries(input: {
  readonly cakes: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly attachments: ReadonlyArray<CakeAttachmentView>;
  readonly runningCakeId: string | null;
}): ReadonlyArray<CakeThreadEntry> {
  const nameById = new Map(input.cakes.map((cake) => [cake.id, cake.name]));
  return input.attachments.flatMap((attachment) => {
    // A deleted cake can leave its attachment behind. A nameless
    // switch in the composer toggles something the user cannot identify.
    const name = nameById.get(attachment.cakeId);
    if (name === undefined) return [];
    const status: CakeThreadStatus =
      attachment.cakeId === input.runningCakeId
        ? "active"
        : attachment.enabled && attachment.nextRunAt !== null
          ? "scheduled"
          : "idle";
    return [{ cakeId: attachment.cakeId, name, enabled: attachment.enabled, status }];
  });
}

export function runningCakeEntry(entries: ReadonlyArray<CakeThreadEntry>): CakeThreadEntry | null {
  return entries.find((entry) => entry.status === "active") ?? null;
}

/**
 * Which cake is running on the thread this client is showing.
 *
 * Two sources, ranked. `serverCakeId` is the server matching the thread's
 * active turn against the run that started it, so it sees runs this client
 * never witnessed — which is the normal case, because the scheduler starts
 * them. `pending` is the run this client fired a moment ago, kept so the Stop
 * Cake button lights on the click rather than on the round-trip.
 *
 * The server wins when they disagree: `pending` is a client's memory of an
 * intent and can outlive its run, while the server's answer is the run and the
 * turn actually joining up. Both are still gated on the thread being busy, or
 * the button outlives the run it offers to stop.
 */
export function resolveRunningCakeId(input: {
  readonly serverCakeId?: string | null;
  readonly pending: { readonly threadId: string; readonly cakeId: string } | null;
  readonly threadId: string | null;
  readonly threadIsBusy: boolean;
}): string | null {
  if (input.threadId === null || !input.threadIsBusy) return null;
  const serverCakeId = input.serverCakeId ?? null;
  if (serverCakeId !== null) return serverCakeId;
  if (input.pending === null || input.pending.threadId !== input.threadId) return null;
  return input.pending.cakeId;
}

/**
 * The `cakes.stop` call a Stop Cake press makes, or nothing.
 *
 * Separate from pressing the button because the two effects of a press are not
 * the same: interrupting the thread always makes sense, while closing a run
 * needs a cake and a thread to name. When either is missing the press still
 * interrupts and simply records nothing, rather than guessing at which run to
 * mark stopped.
 */
export function cakeStopRequest(input: {
  readonly runningCakeId: string | null;
  readonly threadId: string | null;
}): { readonly cakeId: string; readonly threadId: string } | null {
  if (input.runningCakeId === null || input.threadId === null) return null;
  return { cakeId: input.runningCakeId, threadId: input.threadId };
}

/**
 * One row of the Cakes shelf, as the panel should draw it.
 *
 * The shelf lists every cake on the environment, while `enabled`, the next slot
 * and "is this the one running" are all facts about an *attachment* to the
 * thread in front of the user. A cake with no attachment is therefore not an
 * error state: it is a cake this thread does not run, and it says so.
 */
export interface CakeShelfRow {
  readonly cakeId: string;
  readonly enabled: boolean;
  /** Decides the first button: Stop for this cake, Start for every other. */
  readonly isRunning: boolean;
  /**
   * The same three states `deriveCakeThreadEntries` names, on the row that
   * draws them.
   *
   * A field rather than something the component works out from
   * `nextRunLabel`, because the label is prose — "Next run: not scheduled" —
   * and a component that reads state out of a sentence breaks the moment the
   * sentence is reworded or translated.
   */
  readonly status: CakeThreadStatus;
  readonly nextRunLabel: string;
}

/**
 * When the cake next runs, in words.
 *
 * `nowMs` is a parameter because "today" is a question about an instant, and a
 * function that reads the clock itself cannot be asked that question twice.
 * `timeZone` likewise: undefined means the host's zone, which is right for the
 * panel and untestable, so tests name one.
 *
 * The time is assembled from `formatToParts` rather than taken as a formatted
 * string: ICU separates the time from AM/PM with a narrow no-break space, which
 * looks identical and is not the space this UI's other labels use.
 */
export function formatCakeNextRun(input: {
  readonly nextRunAt: DateTime.Utc | null;
  readonly nowMs: number;
  readonly timeZone?: string | undefined;
}): string {
  if (input.nextRunAt === null) return "Next run: not scheduled";
  const at = DateTime.toEpochMillis(input.nextRunAt);

  const timeParts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: input.timeZone,
  }).formatToParts(at);
  const partValue = (type: Intl.DateTimeFormatPartTypes): string =>
    timeParts.find((part) => part.type === type)?.value ?? "";
  const time = `${partValue("hour")}:${partValue("minute")} ${partValue("dayPeriod")}`;

  const calendarDay = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: input.timeZone,
  });
  const day =
    calendarDay.format(at) === calendarDay.format(input.nowMs)
      ? "today"
      : new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          timeZone: input.timeZone,
        }).format(at);

  return `Next run: ${time}, ${day}`;
}

/**
 * What the shelf needs from the thread it is sitting next to.
 *
 * Null when there is no thread: every control on a row is an instruction about
 * running this cake *here*, so without a thread the shelf is a catalogue and
 * shows no buttons rather than dead ones.
 */
export interface CakeShelfModel {
  readonly attachments: ReadonlyArray<CakeAttachmentView>;
  readonly runningCakeId: string | null;
  /** Attaches the cake to this thread if it is not attached, then runs it. */
  readonly onRunNow: (cakeId: string) => void;
  readonly onStop: () => void;
  readonly onSetEnabled: (cakeId: string, enabled: boolean) => void;
}

export function deriveCakeShelfRow(input: {
  readonly cakeId: string;
  readonly attachments: ReadonlyArray<CakeAttachmentView>;
  readonly runningCakeId: string | null;
  readonly nowMs: number;
  readonly timeZone?: string | undefined;
}): CakeShelfRow {
  const attachment =
    input.attachments.find((candidate) => candidate.cakeId === input.cakeId) ?? null;
  const isRunning = input.runningCakeId === input.cakeId;
  const isScheduled = attachment !== null && attachment.enabled && attachment.nextRunAt !== null;

  return {
    cakeId: input.cakeId,
    // An unattached cake is off on this thread, so the lock reads as locked and
    // one click both attaches and enables it.
    enabled: attachment?.enabled ?? false,
    isRunning,
    status: isRunning ? "active" : isScheduled ? "scheduled" : "idle",
    nextRunLabel: formatCakeNextRun({
      // A disabled attachment can still carry a stale slot. Showing it would
      // promise a run the scheduler will not make.
      nextRunAt: attachment !== null && attachment.enabled ? attachment.nextRunAt : null,
      nowMs: input.nowMs,
      timeZone: input.timeZone,
    }),
  };
}

/** Title of the thread the fork option creates. Mirrors the dialog's wording. */
export function forkedCakeThreadTitle(cakeName: string, threadTitle: string): string {
  const host = threadTitle.trim();
  return host.length === 0 ? cakeName : `${cakeName} in ${host}`;
}
