import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CakeRepository } from "./CakeRepository.ts";
import { runCakeTickOnce, type CakeTurnStarter } from "./CakeScheduleReactor.ts";

/**
 * Firing a cake because a person asked, rather than because a slot came round.
 *
 * A plain function for the same reason `cakeTurnCommand.ts` is one: while this
 * lived inline in `ws.ts` the version the server ran was the version no test
 * could import, so the one thing that distinguishes a manual run from a
 * scheduled one — whether the thread's session is torn down first — was
 * reachable only from a reconstruction.
 */

export interface CakeRunNowRequest {
  readonly cakeId: string;
  readonly threadId: string;
  /**
   * End the thread's provider session before the cake's turn starts.
   *
   * The drop dialog's "stop the current agent, and spawn the cake" answer says
   * true here; the shelf's Start button says false. Required rather than
   * optional because the two answers differ *only* by this, and a default would
   * be one of them chosen silently for a caller that forgot.
   */
  readonly endSessionFirst: boolean;
}

export interface CakeRunNowIO {
  readonly now: number;
  /**
   * The starter to run this cake's turn with.
   *
   * A function of the request rather than a fixed value, because the ordering
   * instruction has to reach `dispatchCakeTurn`, and the starter is the only
   * thing that talks to it. A starter captured once for the whole server would
   * make the flag global — every Start button press would tear down a session.
   */
  readonly starterFor: (options: { readonly endSessionFirst: boolean }) => CakeTurnStarter;
}

export const runCakeNow = (request: CakeRunNowRequest, io: CakeRunNowIO) =>
  Effect.gen(function* () {
    const repository = yield* CakeRepository;
    const attachments = yield* repository.listAttachmentsForThread(request.threadId);
    const attachment = attachments.find((item) => item.cakeId === request.cakeId);
    // Nothing to fire. A cake that is not attached to this thread has no run to
    // start here, and inventing an attachment would schedule it as a side
    // effect of pressing a button.
    if (attachment === undefined) return;

    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(io.now));

    // Two named inputs, not a cloned service. This used to hand the tick a
    // `CakeRepository` whose `listDue` returned this one attachment and whose
    // `setNextRun` did nothing — a button press impersonating the scheduler.
    // The masquerade coupled them: any repository call added to the tick path
    // would have reached the real implementation through a service this caller
    // believed it had replaced, and nothing would have said so.
    yield* runCakeTickOnce({
      now: io.now,
      shouldRunOpportunisticWork: true,
      starter: io.starterFor({ endSessionFirst: request.endSessionFirst }),
      // Due right now, and enabled whatever the attachment says: the person
      // pressing the button is the schedule for this one run.
      dueOverride: [{ ...attachment, enabled: true, nextRunAt: nowIso }],
      // A manual run happens outside the schedule. Consuming the next slot
      // would make Start quietly cancel the run it was standing in for.
      advanceSlots: false,
    });
  });
