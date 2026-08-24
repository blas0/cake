import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Cake configuration lives on the environment that runs it, so the settings
 * page reads and writes it over the same RPC boundary as everything else.
 *
 * Two groups, kept apart by name rather than by file. `cakesEnvironment` is
 * what the settings page needs: the catalogue of cakes and the writes that
 * change it. `cakeThreadEnvironment` is what a thread needs: which cakes are
 * attached to it and the per-attachment writes. Splitting them keeps the
 * settings page from growing a thread-shaped concern, which is the reason the
 * thread methods were left out of this file in the first place.
 */
export const cakesEnvironment = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:cakes:list",
    tag: WS_METHODS.cakesList,
  }),
  upsert: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:cakes:upsert",
    tag: WS_METHODS.cakesUpsert,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:cakes:delete",
    tag: WS_METHODS.cakesDelete,
  }),
};

/**
 * How often an attachment list re-reads its own schedule.
 *
 * Matched to the scheduler's own tick (`DEFAULT_TICK_INTERVAL_MS`), because
 * that is the fastest `nextRunAt` can move: asking more often only ever gets
 * the same answer back.
 *
 * A poll rather than a push, which this codebase otherwise reserves for
 * expiring asset URLs. The alternative is a streaming RPC per thread, and
 * nothing else about attachments justifies one — the whole payload is a handful
 * of rows, and the only field that moves on its own is a timestamp. What forced
 * *some* mechanism is that the client cannot infer the move: a slot advances
 * when the scheduler fires it, and a cake whose provider does not match its
 * thread now fires on a *forked* thread, so the thread the user is looking at
 * never turns busy and has no local signal at all. Before this, "Next run" was
 * frozen at whatever it said when the thread was opened.
 */
const CAKE_ATTACHMENT_REFRESH_INTERVAL_MS = 30_000;

/**
 * The thread's half: attachments and the writes scoped to one of them.
 *
 * Every write here names a thread as well as a cake. A cake can be attached to
 * several threads at once, so switching one off in this thread's composer must
 * not reach the others.
 */
export const cakeThreadEnvironment = {
  listForThread: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:cakes:list-for-thread",
    tag: WS_METHODS.cakesListForThread,
    refreshIntervalMs: CAKE_ATTACHMENT_REFRESH_INTERVAL_MS,
  }),
  /**
   * Which cake owns the turn this thread is running, as the server sees it.
   *
   * The composer cannot work this out for itself: a scheduled run leaves no
   * trace in any browser, so without this the Stop Cake button only ever
   * appeared for a run the user had just clicked.
   */
  activeForThread: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:cakes:active-for-thread",
    tag: WS_METHODS.cakesActiveForThread,
  }),
  attach: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:cakes:attach",
    tag: WS_METHODS.cakesAttach,
  }),
  detach: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:cakes:detach",
    tag: WS_METHODS.cakesDetach,
  }),
  setEnabled: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:cakes:set-enabled",
    tag: WS_METHODS.cakesSetEnabled,
  }),
  runNow: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:cakes:run-now",
    tag: WS_METHODS.cakesRunNow,
  }),
  /**
   * Closes the run. The interrupt is what stops the agent; this is what makes
   * the stop a fact the run history can read back, so the button sends both.
   */
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:cakes:stop",
    tag: WS_METHODS.cakesStop,
  }),
};
