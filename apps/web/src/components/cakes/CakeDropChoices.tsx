"use client";

import { GitBranchIcon, OctagonXIcon } from "lucide-react";

/**
 * The two answers to "a cake was dropped on a thread that is already working".
 *
 * Split out of `CakeDropDialog` the way `CakeForm` was split out of
 * `CakeFormDialog`: the dialog is portal chrome, so the wording of the choices
 * — the only part a user actually reads — could not be rendered on its own.
 *
 * The avatar arrives as a node rather than being built from the cake here. The
 * face is the caller's business, and injecting it keeps this component free of
 * the canvas the avatar renders into.
 *
 * Fork is listed first: it is the answer that loses nothing.
 */
export function CakeDropChoices({
  cakeName,
  threadTitle,
  avatar,
  onFork,
  onStopAndSpawn,
}: {
  readonly cakeName: string;
  readonly threadTitle: string;
  readonly avatar: React.ReactNode;
  readonly onFork: () => void;
  readonly onStopAndSpawn: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 px-4 pb-2 sm:px-6">
      <button
        type="button"
        onClick={onFork}
        className="flex w-full cursor-pointer items-start gap-3 rounded-lg border border-border/80 bg-card p-3 text-left transition hover:border-border hover:bg-accent/60"
      >
        <GitBranchIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
        <span className="min-w-0 text-sm text-foreground">
          Start a new forked thread with {avatar} <span className="font-medium">{cakeName}</span> in{" "}
          <span className="font-medium">{threadTitle}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={onStopAndSpawn}
        className="flex w-full cursor-pointer items-start gap-3 rounded-lg border border-border/80 bg-card p-3 text-left transition hover:border-border hover:bg-accent/60"
      >
        <OctagonXIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-destructive-foreground"
        />
        <span className="min-w-0 text-sm text-foreground">
          Stop the current agent, and spawn the cake
        </span>
      </button>
    </div>
  );
}
