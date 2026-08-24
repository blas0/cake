import { EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { watchThreadSessionStopped } from "./cakeSessionStopWatch.ts";

/**
 * The wait a fresh-session cake puts between its session stop and its turn.
 *
 * What it is watching for is a live event, and both ways of getting it wrong
 * are silent: a watch that never fires parks the scheduler tick forever, and a
 * watch that fires on the wrong event lets the turn start before the session it
 * was meant to discard is gone.
 */

const sessionSet = (input: {
  readonly sequence: number;
  readonly threadId: string;
  readonly status: "ready" | "stopped";
}): OrchestrationEvent =>
  ({
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: "thread.session-set",
    aggregateKind: "thread",
    aggregateId: ThreadId.make(input.threadId),
    occurredAt: "2026-03-10T09:00:30.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: ThreadId.make(input.threadId),
      session: {
        threadId: ThreadId.make(input.threadId),
        status: input.status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-03-10T09:00:30.000Z",
      },
    },
  }) as OrchestrationEvent;

/** The engine reduced to the one thing the watch reads: its live event tail. */
const enginePublishing = (events: PubSub.PubSub<OrchestrationEvent>): OrchestrationEngineShape => ({
  readEvents: () => Stream.empty,
  dispatch: () => Effect.succeed({ sequence: 0 }),
  get streamDomainEvents() {
    return Stream.fromPubSub(events);
  },
  latestSequence: Effect.succeed(0),
});

it.effect("returns once the watched thread's session reaches stopped", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const stopped = yield* watchThreadSessionStopped(enginePublishing(events), "thread-1");
    const waiting = yield* Effect.forkChild(stopped);

    // Published after the watch was attached, which is the ordering the caller
    // relies on: the stop is dispatched only once this watch exists.
    yield* PubSub.publish(
      events,
      sessionSet({ sequence: 1, threadId: "thread-1", status: "stopped" }),
    );

    yield* Fiber.join(waiting);
    expect(waiting.pollUnsafe()).toBeDefined();
  }).pipe(Effect.scoped),
);

/**
 * Anything but this thread's session actually stopping is not the signal. A
 * watch that fired on a neighbouring thread's stop would release the turn while
 * this thread's session was still alive — the bug the wait exists to prevent,
 * with the wait still in place.
 */
it.effect("keeps waiting through another thread's stop and its own non-stopped statuses", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const stopped = yield* watchThreadSessionStopped(enginePublishing(events), "thread-1");
    const waiting = yield* Effect.forkChild(stopped);

    yield* PubSub.publish(
      events,
      sessionSet({ sequence: 1, threadId: "thread-2", status: "stopped" }),
    );
    yield* PubSub.publish(
      events,
      sessionSet({ sequence: 2, threadId: "thread-1", status: "ready" }),
    );
    yield* TestClock.adjust(Duration.seconds(10));

    expect(waiting.pollUnsafe()).toBeUndefined();

    yield* PubSub.publish(
      events,
      sessionSet({ sequence: 3, threadId: "thread-1", status: "stopped" }),
    );
    yield* Fiber.join(waiting);
    expect(waiting.pollUnsafe()).toBeDefined();
  }).pipe(Effect.scoped),
);

/**
 * The wait sits inside the scheduler tick, so a stop the reactor never settles
 * — a deleted thread, a provider teardown that failed and was logged — must not
 * park it forever. Every other cake ticks behind this one.
 */
it.effect("gives up rather than parking the tick when the stop never settles", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const stopped = yield* watchThreadSessionStopped(enginePublishing(events), "thread-1");
    const waiting = yield* Effect.forkChild(stopped);

    yield* TestClock.adjust(Duration.minutes(1));

    yield* Fiber.join(waiting);
    expect(waiting.pollUnsafe()).toBeDefined();
  }).pipe(Effect.scoped),
);
