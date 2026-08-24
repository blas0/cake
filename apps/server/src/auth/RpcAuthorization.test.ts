import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("cake authorization scopes", () => {
  /**
   * Reads take the read scope, like every other read in the table. All ten cake
   * methods were given the operate scope together, which left a read-scoped
   * client able to inspect everything in the app except cakes.
   */
  it.each([WS_METHODS.cakesList, WS_METHODS.cakesListForThread, WS_METHODS.cakesActiveForThread])(
    "authorizes %s with the read scope",
    (method) => {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    },
  );

  /**
   * The other half, and the reason the first half is safe: everything that
   * starts, stops, attaches or edits an unattended agent still needs operate.
   */
  it.each([
    WS_METHODS.cakesUpsert,
    WS_METHODS.cakesDelete,
    WS_METHODS.cakesAttach,
    WS_METHODS.cakesDetach,
    WS_METHODS.cakesSetEnabled,
    WS_METHODS.cakesRunNow,
    WS_METHODS.cakesStop,
  ])("still requires the operate scope for %s", (method) => {
    expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
  });
});

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});
