import {
  CommandId,
  ProviderDriverKind,
  ProviderInstanceId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { PlannedTurnStart } from "./applyCakeTick.ts";
import {
  buildCakeSessionStopCommand,
  buildCakeTurnCommand,
  dispatchCakeTurn,
} from "./cakeTurnCommand.ts";

/**
 * The one place a cake becomes work the rest of t3code understands.
 *
 * Everything upstream of this is cake-shaped; everything downstream is an
 * ordinary turn. That makes this the seam where a cake's decisions either reach
 * the provider or are silently dropped — and dropped is the likely failure,
 * because a turn with a missing field still runs, just not as configured.
 */

const turn: PlannedTurnStart = {
  cakeId: "cake-1",
  threadId: "thread-1",
  messageId: "msg-1",
  prompt: "# CAKE.md\n\nTriage the inbox.",
  providerKind: "claudeAgent",
  model: "claude-opus-5",
  effort: "high",
  disallowedTools: ["Bash"],
};

const build = (overrides: Partial<PlannedTurnStart> = {}) =>
  buildCakeTurnCommand({
    turn: { ...turn, ...overrides },
    commandId: CommandId.make("cmd-1"),
    now: "2026-03-10T09:00:00.000Z",
  });

describe("buildCakeTurnCommand", () => {
  /**
   * A scheduled cake is configured by driver kind, not by instance, so the
   * command has to name an instance the router will recognise. The mapping from
   * a driver kind to its default instance id is a documented back-compat rule
   * this repo owns in `defaultInstanceIdForDriver`; the command used to spell it
   * inline as `ProviderInstanceId.make(providerKind)`, which reads as a cast
   * laundering one brand into another and would drift the day the rule changes.
   */
  it("routes a driver-configured cake to that driver's default instance", () => {
    const command = build({ providerKind: "claudeAgent" });

    expect(command.modelSelection?.instanceId).toBe(
      defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent")),
    );
  });

  /** An explicit instance still wins — a forked run resolves a real one. */
  it("prefers an instance the caller resolved", () => {
    const command = buildCakeTurnCommand({
      turn: { ...turn, providerKind: "claudeAgent" },
      commandId: CommandId.make("cmd-1"),
      now: "2026-03-10T09:00:00.000Z",
      instanceId: ProviderInstanceId.make("claudeAgent-2"),
    });

    expect(command.modelSelection?.instanceId).toBe("claudeAgent-2");
  });

  it("starts a turn on the cake's thread", () => {
    const command = build();
    expect(command.type).toBe("thread.turn.start");
    expect(command.threadId).toBe("thread-1");
  });

  it("sends CAKE.md as the user turn", () => {
    expect(build().message.text).toBe("# CAKE.md\n\nTriage the inbox.");
    expect(build().message.role).toBe("user");
  });

  /**
   * The decision that makes cakes work at all, and the one that would be
   * easiest to lose. `full-access` is what every adapter maps to its own
   * unattended mode — Claude's `bypassPermissions`, Codex's `never` plus
   * `danger-full-access`. Any other value here means a scheduled cake stops at
   * 3am waiting for an approval nobody is awake to give.
   */
  it("runs at full access, because nobody is watching", () => {
    expect(build().runtimeMode).toBe("full-access");
  });

  it("carries the cake's model", () => {
    expect(build().modelSelection?.model).toBe("claude-opus-5");
  });

  it("carries the cake's effort", () => {
    const command = build();
    expect(JSON.stringify(command.modelSelection)).toContain("high");
  });

  it("uses the ids and timestamp it was given rather than minting its own", () => {
    const command = build();
    expect(command.commandId).toBe("cmd-1");
    expect(command.message.messageId).toBe("msg-1");
    expect(command.createdAt).toBe("2026-03-10T09:00:00.000Z");
  });

  /**
   * The run already wrote this exact value down, and it is the only identifier
   * the run and the turn share — the command carries no turn id, and the turn
   * id is minted later by the provider runtime. A fresh id here would still
   * start a perfectly good turn, so nothing downstream would complain; it would
   * simply be a turn nobody could trace back to the cake, and "Stop Cake" would
   * never appear for a run the scheduler started.
   */
  it("carries the planner's message id for every turn it is given", () => {
    for (const messageId of ["msg-1", 'cake-turn:["cake-1","thread-1",1772787600000]']) {
      expect(build({ messageId }).message.messageId).toBe(messageId);
    }
  });

  it("sends no attachments", () => {
    expect(build().message.attachments).toEqual([]);
  });

  /**
   * A cake is not a person typing, so it must not land in a mode that waits for
   * one. Whatever the thread was last set to, a scheduled run builds its own
   * command rather than inheriting a half-finished interactive state.
   */
  it("does not inherit an interactive plan mode", () => {
    expect(build().interactionMode).toBe("default");
    expect(build().interactionMode).not.toBe("plan");
  });

  /**
   * Codex names the same knob differently. An option id an adapter does not
   * recognise is dropped without complaint, so getting this wrong produces a
   * cake that runs at the provider's default effort while the UI shows the one
   * the user picked.
   */
  it("names the effort option the way the provider does", () => {
    expect(build({ providerKind: "codex" }).modelSelection?.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
    expect(build({ providerKind: "claudeAgent" }).modelSelection?.options).toEqual([
      { id: "effort", value: "high" },
    ]);
  });

  /** No effort means the provider's default, which is said by saying nothing. */
  it("sends no effort option when the cake has no effort", () => {
    expect(build({ effort: "" }).modelSelection?.options).toBeUndefined();
  });

  it("builds the same shape for every provider", () => {
    for (const providerKind of ["claudeAgent", "codex", "cursor", "grok"]) {
      const command = build({ providerKind });
      expect(command.runtimeMode).toBe("full-access");
      expect(command.message.text).toBe(turn.prompt);
    }
  });
});

/**
 * Ending the thread's session before the turn, as an order of events.
 *
 * It has no field of its own on the wire: continuing is an ordinary turn start,
 * and starting fresh is that same turn start preceded by a session stop that
 * has already taken effect. So the entire behaviour is what is sent and when,
 * which is what these assert.
 *
 * `endSessionFirst` is an instruction from the caller rather than something
 * read off the cake — the switch it used to be read from is gone, because a
 * session-level stop could not deliver what it promised. The sequencing is kept
 * because ending the agent currently working in a thread and starting a cake in
 * its place is still a thing a person can ask for.
 */
describe("dispatchCakeTurn", () => {
  /**
   * The sequence as the world outside would see it: every command sent, plus
   * the moment the thread's session really reached "stopped".
   *
   * Recording the settle alongside the commands is the point. A version that
   * sent the stop first and the turn immediately after would produce the same
   * two commands in the same order and still be the bug — the stop is handled
   * asynchronously, so "sent first" is not "took effect first".
   */
  const run = (options: { readonly endSessionFirst?: boolean } = {}) =>
    Effect.gen(function* () {
      const steps: Array<string> = [];
      yield* dispatchCakeTurn(
        {
          turn,
          commandId: CommandId.make("cmd-1"),
          sessionStopCommandId: CommandId.make("cmd-stop-1"),
          now: "2026-03-10T09:00:00.000Z",
          ...options,
        },
        {
          dispatch: (command) =>
            Effect.sync(() => {
              steps.push(command.type);
              return command;
            }),
          watchSessionStopped: (threadId) =>
            Effect.sync(() => {
              steps.push(`watch:${threadId}`);
              return Effect.sync(() => {
                steps.push("session-stopped");
              });
            }),
        },
      );
      return steps;
    });

  effectIt.effect("sends nothing but the turn when the session is kept", () =>
    Effect.gen(function* () {
      expect(yield* run()).toEqual(["thread.turn.start"]);
    }),
  );

  /**
   * The order is the behaviour, and the settle is part of it. Without the wait
   * the turn resumes the session the stop is about to discard, and the stop
   * landing afterwards clears the pending turn row the run is joined through —
   * a cake that both remembers what it should have forgotten and loses its
   * link to the turn it started.
   */
  effectIt.effect("waits for the session to actually stop before starting a fresh turn", () =>
    Effect.gen(function* () {
      expect(yield* run({ endSessionFirst: true })).toEqual([
        "watch:thread-1",
        "thread.session.stop",
        "session-stopped",
        "thread.turn.start",
      ]);
    }),
  );

  /**
   * The watch is attached before the stop is dispatched, not after. The signal
   * it waits on is a live event, so a watch attached afterwards can miss the
   * stop entirely — and the failure is not a late turn but a turn that never
   * starts.
   */
  effectIt.effect("watches for the stop before requesting it", () =>
    Effect.gen(function* () {
      const steps = yield* run({ endSessionFirst: true });
      expect(steps.indexOf("watch:thread-1")).toBeLessThan(steps.indexOf("thread.session.stop"));
    }),
  );
});

/**
 * The stop itself, which only exists on the fresh-session half.
 */
describe("buildCakeSessionStopCommand", () => {
  const stop = (
    options: {
      readonly endSessionFirst?: boolean;
      readonly turn?: Partial<PlannedTurnStart>;
    } = {},
  ) =>
    buildCakeSessionStopCommand({
      turn: { ...turn, ...options.turn },
      commandId: CommandId.make("cmd-1"),
      sessionStopCommandId: CommandId.make("cmd-stop-1"),
      now: "2026-03-10T09:00:00.000Z",
      endSessionFirst: options.endSessionFirst ?? true,
    });

  /**
   * Absent means "keep the session", not "decide from something else". A caller
   * that forgets the flag must get an ordinary turn start rather than one that
   * silently discards whatever the thread was in the middle of.
   */
  it("sends no stop when the caller does not ask for one", () => {
    expect(stop({ endSessionFirst: false })).toBeNull();
    expect(
      buildCakeSessionStopCommand({
        turn,
        commandId: CommandId.make("cmd-1"),
        sessionStopCommandId: CommandId.make("cmd-stop-1"),
        now: "2026-03-10T09:00:00.000Z",
      }),
    ).toBeNull();
  });

  /**
   * `onlyIfSettled` is the settle-cleanup guard: the decider drops the stop if
   * the thread is unsettled, has a live session, or has a queued turn start.
   * A firing cake is in all three states, so setting it would discard the stop
   * in exactly the case it exists for.
   */
  it("stops unconditionally rather than only when the thread is settled", () => {
    expect(stop()?.type).toBe("thread.session.stop");
    expect(stop()).not.toHaveProperty("onlyIfSettled");
  });

  it("stops the cake's own thread, under the id it was given", () => {
    expect(stop({ turn: { threadId: "thread-9" } })).toMatchObject({
      threadId: "thread-9",
      commandId: "cmd-stop-1",
      createdAt: "2026-03-10T09:00:00.000Z",
    });
  });
});
