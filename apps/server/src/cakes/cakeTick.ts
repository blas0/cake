import type { CakeSchedule } from "@t3tools/contracts";
import { nextRunAfter } from "@t3tools/shared/cakeSchedule";

/**
 * One scheduler tick, decided purely.
 *
 * All of the policy lives here and none of the IO does, for two reasons. The
 * repo forbids sleep-based tests and a scheduler is the component most tempting
 * to write one for; and the interesting failures are all decisions, not
 * database calls. The reactor around this reads, applies these decisions, and
 * nothing else.
 *
 * The distinction that matters is between deferring and missing. A **deferred**
 * run is still owed: the machine was busy, the slot stays exactly where it is,
 * and the next willing tick fires it. A **missed** run is gone: its moment
 * passed while nothing was running, and replaying it would either run a nightly
 * cake at whatever hour the user reopened the app, or run a dozen of them at
 * once. Collapsing the two either loses work or stampedes a busy machine.
 */

export interface DueCake {
  readonly cakeId: string;
  readonly threadId: string;
  /** The slot this attachment is currently waiting on. */
  readonly nextRunAt: number;
  readonly schedule: CakeSchedule;
}

export type CakeTickDecision =
  | {
      readonly kind: "fire";
      readonly cakeId: string;
      readonly threadId: string;
      readonly scheduledFor: number;
      /** Written back immediately, so one slot cannot fire twice. */
      readonly nextRunAt: number;
    }
  | {
      readonly kind: "defer";
      readonly cakeId: string;
      readonly threadId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "skip-missed";
      readonly cakeId: string;
      readonly threadId: string;
      readonly scheduledFor: number;
      readonly nextRunAt: number;
    };

export interface CakeTickInput {
  readonly now: number;
  /** `BackgroundPolicy`'s verdict on whether this machine wants extra work. */
  readonly shouldRunOpportunisticWork: boolean;
  readonly due: ReadonlyArray<DueCake>;
  /**
   * How late a slot may be and still count as fired rather than missed.
   *
   * A tick interval is not instant, so ordinary lateness is measured in
   * seconds and must not be treated as a miss — a scheduler that called every
   * late run "missed" would never run anything at all.
   */
  readonly latenessGraceMs?: number;
}

const DEFAULT_LATENESS_GRACE_MS = 15 * 60 * 1000;

/**
 * Walk a schedule forward until its slot is in the future.
 *
 * Advancing one period at a time from a long-past slot would leave the answer
 * still in the past and make every tick grind through months of them, so this
 * asks the schedule where it goes next *from now* — the grid is absolute, so
 * that lands on a real slot rather than an offset from an arbitrary moment.
 */
function slotAfter(schedule: CakeSchedule, now: number): number {
  return nextRunAfter(schedule, now);
}

export function decideCakeTick(input: CakeTickInput): ReadonlyArray<CakeTickDecision> {
  const grace = input.latenessGraceMs ?? DEFAULT_LATENESS_GRACE_MS;

  return input.due.map((entry): CakeTickDecision => {
    // Checked before lateness on purpose: recording a miss is a write, and an
    // unwilling host should be doing no work at all, not bookkeeping.
    if (!input.shouldRunOpportunisticWork) {
      return {
        kind: "defer",
        cakeId: entry.cakeId,
        threadId: entry.threadId,
        reason: "the host is not accepting background work right now",
      };
    }

    const lateness = input.now - entry.nextRunAt;
    if (lateness > grace) {
      return {
        kind: "skip-missed",
        cakeId: entry.cakeId,
        threadId: entry.threadId,
        scheduledFor: entry.nextRunAt,
        nextRunAt: slotAfter(entry.schedule, input.now),
      };
    }

    return {
      kind: "fire",
      cakeId: entry.cakeId,
      threadId: entry.threadId,
      scheduledFor: entry.nextRunAt,
      nextRunAt: slotAfter(entry.schedule, input.now),
    };
  });
}
