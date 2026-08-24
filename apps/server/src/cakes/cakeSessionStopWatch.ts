import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

/**
 * How long a fresh-session cake waits for its own stop to take effect.
 *
 * Bounded because the wait sits inside the tick: a stop the reactor never
 * settles — a deleted thread, a provider teardown that failed and was logged —
 * would otherwise park the tick fiber forever and take every other cake down
 * with it. Past the bound the turn is started anyway: a cake that runs with a
 * session it should have discarded is a worse turn, but a cake that never runs
 * again is a broken feature.
 */
const SESSION_STOP_SETTLE_TIMEOUT = Duration.seconds(30);

const isSessionStoppedFor =
  (threadId: string) =>
  (event: OrchestrationEvent): boolean =>
    event.type === "thread.session-set" &&
    event.payload.threadId === threadId &&
    event.payload.session.status === "stopped";

/**
 * Watches for a thread's session to actually reach `stopped`, and returns the
 * wait.
 *
 * The subscription is attached before this returns — `startImmediately` runs
 * the forked fiber up to its first suspension, which is the PubSub subscribe —
 * so a caller that dispatches the stop after calling this cannot lose the
 * event in between. `streamDomainEvents` is live-only, and a missed event here
 * is not a late turn but a turn that never starts.
 *
 * The wait itself cannot fail: a stop that never settles is reported and then
 * conceded, because the alternative is a scheduler that stops ticking.
 */
export const watchThreadSessionStopped = (
  engine: OrchestrationEngineShape,
  threadId: string,
): Effect.Effect<Effect.Effect<void>, never, Scope.Scope> =>
  Deferred.make<void>().pipe(
    Effect.tap((stopped) =>
      Effect.forkScoped(
        engine.streamDomainEvents.pipe(
          Stream.filter(isSessionStoppedFor(threadId)),
          Stream.runHead,
          Effect.andThen(Deferred.succeed(stopped, undefined)),
        ),
        { startImmediately: true },
      ),
    ),
    Effect.map((stopped) =>
      Deferred.await(stopped).pipe(
        Effect.timeout(SESSION_STOP_SETTLE_TIMEOUT),
        Effect.catchCause((cause) =>
          Effect.logWarning("cake session stop did not settle before its turn", {
            threadId,
            cause,
          }),
        ),
        Effect.asVoid,
      ),
    ),
  );
