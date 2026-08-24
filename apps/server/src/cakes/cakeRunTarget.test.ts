import { describe, expect, it } from "@effect/vitest";

import { decideCakeRunTarget } from "./cakeRunTarget.ts";

const startedThread = (instanceId: string, model: string) => ({
  hasStartedConversation: true,
  modelSelection: { instanceId, model },
});

describe("decideCakeRunTarget", () => {
  it("runs in place before the thread's conversation starts", () => {
    expect(
      decideCakeRunTarget({
        thread: {
          hasStartedConversation: false,
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
        },
        cake: { instanceId: "claudeAgent", model: "claude-fable-5" },
      }),
    ).toEqual({ kind: "in-place" });
  });

  it("runs in place when the instance and model both match", () => {
    expect(
      decideCakeRunTarget({
        thread: startedThread("claudeAgent", "claude-opus-5"),
        cake: { instanceId: "claudeAgent", model: "claude-opus-5" },
      }),
    ).toEqual({ kind: "in-place" });
  });

  it("forks an Opus thread for a Fable cake", () => {
    expect(
      decideCakeRunTarget({
        thread: startedThread("claudeAgent", "claude-opus-5"),
        cake: { instanceId: "claudeAgent", model: "claude-fable-5" },
      }),
    ).toEqual({ kind: "fork" });
  });

  it("forks any model difference on one instance", () => {
    expect(
      decideCakeRunTarget({
        thread: startedThread("grok", "grok-4"),
        cake: { instanceId: "grok", model: "grok-code" },
      }),
    ).toEqual({ kind: "fork" });
  });

  it("forks a different instance even when the model label matches", () => {
    expect(
      decideCakeRunTarget({
        thread: startedThread("claudeAgent", "claude-opus-5"),
        cake: { instanceId: "claudeAgent-2", model: "claude-opus-5" },
      }),
    ).toEqual({ kind: "fork" });
  });

  it("forks a cross-driver selection", () => {
    expect(
      decideCakeRunTarget({
        thread: startedThread("claudeAgent", "claude-opus-5"),
        cake: { instanceId: "codex", model: "gpt-5.6-sol" },
      }),
    ).toEqual({ kind: "fork" });
  });

  it("runs in place when the attached thread cannot be read", () => {
    expect(
      decideCakeRunTarget({
        thread: null,
        cake: { instanceId: "claudeAgent", model: "claude-fable-5" },
      }),
    ).toEqual({ kind: "in-place" });
  });
});
