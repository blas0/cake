import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CakeInput, CakeNotFoundError, CakeStorageError } from "./cakeRpc.ts";
import { CakeConfig, CakeId } from "./cakes.ts";
import {
  WsCakesAttachRpc,
  WsCakesListForThreadRpc,
  WsCakesListRpc,
  WsCakesRunNowRpc,
  WsCakesStopRpc,
} from "./rpc.ts";

/**
 * What a cake operation is allowed to answer when it fails.
 *
 * Every cake handler used to end in `Effect.orDie`, so a repository failure or
 * a cake deleted between two windows killed the fiber rather than replying. The
 * contracts then advertised only `EnvironmentAuthorizationError`, which meant
 * the wire had no way to describe the two things that actually go wrong — and a
 * caller had no way to tell "your view is stale" from "the server is unwell".
 *
 * The RPC declarations are the subject rather than the handlers, because the
 * declaration is the promise: a handler can only return what its contract
 * admits, so pinning the contract is what stops the next handler quietly going
 * back to `orDie`.
 */

/**
 * Whether this RPC's declared error type admits that error.
 *
 * Asked by decoding rather than by reading the schema's shape: the question a
 * caller actually has is "can this method answer with this?", and decoding is
 * how the wire answers it.
 *
 * Decoders are compiled once per RPC and reused — the repo lints against
 * building one inside a call, because the compiled function is rebuilt every
 * time.
 */
const decodeCakeInput = Schema.decodeUnknownSync(CakeInput);
const decodeCakeConfig = Schema.decodeUnknownSync(CakeConfig);
const decodeAttachmentList = Schema.decodeUnknownSync(WsCakesListForThreadRpc.successSchema);

const decoders = new Map<unknown, (error: unknown) => unknown>();
const admits = (rpc: { readonly errorSchema: unknown }, error: unknown): boolean => {
  let decode = decoders.get(rpc);
  if (decode === undefined) {
    decode = Schema.decodeUnknownSync(rpc.errorSchema as Schema.Codec<unknown, unknown>);
    decoders.set(rpc, decode);
  }
  try {
    decode(error);
    return true;
  } catch {
    return false;
  }
};

const NOT_FOUND = { _tag: "CakeNotFoundError", cakeId: "cake_1" };
const STORAGE = { _tag: "CakeStorageError", message: "disk full" };

describe("the errors a cake RPC may answer with", () => {
  it("lets a cake that names an id say it could not find it", () => {
    expect(admits(WsCakesAttachRpc, NOT_FOUND)).toBe(true);
  });

  it("lets every cake operation report a storage failure", () => {
    for (const rpc of [WsCakesListRpc, WsCakesAttachRpc, WsCakesRunNowRpc, WsCakesStopRpc]) {
      expect(admits(rpc, STORAGE)).toBe(true);
    }
  });

  /**
   * A list cannot fail to find a cake — there is no id in the payload to miss.
   * Advertising the error anyway would ask every caller to handle a case that
   * cannot arise.
   */
  it("does not offer a not-found error to an operation that names no cake", () => {
    expect(admits(WsCakesListRpc, NOT_FOUND)).toBe(false);
  });
});

describe("the errors themselves", () => {
  /** The id travels, so a client can say which cake went missing. */
  it("carries the cake id that was not found", () => {
    const error = new CakeNotFoundError({ cakeId: CakeId.make("cake_1") });

    expect(error.cakeId).toBe("cake_1");
    expect(error._tag).toBe("CakeNotFoundError");
  });

  /**
   * Distinct tags, because the two call for different responses: a missing cake
   * is a stale view and a storage failure is a sick server. One tag would tell
   * a user to refresh when the disk is full.
   */
  it("is a different tag from a storage failure", () => {
    const storage = new CakeStorageError({ message: "disk" });

    expect(storage._tag).toBe("CakeStorageError");
    expect(storage._tag).not.toBe("CakeNotFoundError");
  });
});

/**
 * The stored shape and the accepted shape, kept in step.
 *
 * `CakeConfig` and `CakeInput` describe the same cake — one as the server keeps
 * it, one as a client may submit it — and only two fields genuinely differ. They
 * used to be written out by hand, eight fields apiece, which meant a ninth added
 * to one would compile perfectly well while never being accepted from a client.
 * Nothing would have said so.
 */
describe("the accepted cake shape against the stored one", () => {
  it("carries exactly the fields the stored shape does", () => {
    expect(Object.keys(CakeInput.fields).sort()).toEqual(Object.keys(CakeConfig.fields).sort());
  });

  /**
   * The two real differences, asserted so the derivation cannot quietly erase
   * them. A stored schedule accepts what the scheduler can replay; an accepted
   * one refuses a cadence a client should never be able to ask for.
   */
  it("still refuses a schedule the stored shape would tolerate", () => {
    const everySecond = {
      id: "cake_1",
      name: "Nightly",
      providerKind: "claudeAgent",
      model: "claude-opus-5",
      effort: "high",
      schedule: { kind: "every", count: 1, unit: "second" },
      disallowedTools: [],
      instructions: "Do the thing.",
    };

    expect(() => decodeCakeInput(everySecond)).toThrow();
  });

  /**
   * `disallowedTools` has a decoding default when stored — for rows written
   * before the column existed — and none on the way in, where an omitted field
   * should be refused rather than invented.
   */
  it("does not invent a missing tool list the way the stored shape may", () => {
    const withoutTools = {
      id: "cake_1",
      name: "Nightly",
      providerKind: "claudeAgent",
      model: "claude-opus-5",
      effort: "high",
      schedule: { kind: "every", count: 2, unit: "hour" },
      instructions: "Do the thing.",
    };

    expect(() => decodeCakeInput(withoutTools)).toThrow();
    expect(decodeCakeConfig(withoutTools).disallowedTools).toEqual([]);
  });
});

/**
 * Attachment timestamps, refused at the wire rather than re-parsed by hand.
 *
 * `nextRunAt` and `attachedAt` were plain strings, so every client parsed them
 * itself and had to decide what a malformed one meant. The web model's answer
 * was to render "not scheduled" — which reads as a cake with no schedule rather
 * than as a server that wrote a bad timestamp, and says nothing to anyone.
 */
describe("a cake attachment on the wire", () => {
  const attachment = (over: Record<string, unknown>) => ({
    cakeId: "cake_1",
    threadId: "thread_1",
    enabled: true,
    nextRunAt: DateTime.makeUnsafe("2026-01-01T09:00:00.000Z"),
    attachedAt: DateTime.makeUnsafe("2026-01-01T08:00:00.000Z"),
    ...over,
  });

  const decodeList = decodeAttachmentList;

  it("carries instants, not strings", () => {
    expect(() => decodeList([attachment({})])).not.toThrow();
  });

  it("accepts a cake that is attached but not scheduled", () => {
    expect(() => decodeList([attachment({ nextRunAt: null })])).not.toThrow();
  });

  /**
   * The point of the change. These were `Schema.String`, so an ISO string — or
   * anything else — crossed unchallenged and every client parsed it itself. The
   * web model's answer to a malformed one was to render "not scheduled", which
   * reads as a cake with no schedule rather than as a server that wrote a bad
   * timestamp, and told nobody.
   */
  it("refuses a timestamp that is still a string", () => {
    expect(() => decodeList([attachment({ nextRunAt: "2026-01-01T09:00:00.000Z" })])).toThrow();
    expect(() => decodeList([attachment({ attachedAt: "whenever" })])).toThrow();
  });

  /** The thread id is branded now, so a blank one cannot cross either. */
  it("refuses an attachment with a blank thread id", () => {
    expect(() => decodeList([attachment({ threadId: "   " })])).toThrow();
  });
});
