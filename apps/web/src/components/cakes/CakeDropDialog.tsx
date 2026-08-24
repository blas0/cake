"use client";

import type { CakeConfig } from "@t3tools/contracts";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { CakeDropChoices } from "./CakeDropChoices";
import { CakeHashvatar } from "./Hashvatar";
import { CakeStartChoice, CakeStartQuestion } from "./CakeStartChoice";

/**
 * What to do with a cake dropped on a thread that needs an explicit start
 * decision, either because it is already working or has not begun yet.
 *
 * This dialog is the only place the user finds out a turn was already running
 * there, so it states both answers in full rather than asking them to confirm
 * something. Fork is listed first and is the one that loses nothing.
 *
 * The cake's avatar renders inline in the fork wording. That is the reason the
 * hashvatar exists: by the time a user is choosing between two threads, the
 * face is how they know which loop they are about to start.
 */
type CakeDropDialogProps = {
  readonly open: boolean;
  readonly cake: CakeConfig;
  readonly onOpenChange: (open: boolean) => void;
} & (
  | {
      readonly kind: "busy";
      readonly threadTitle: string;
      readonly onFork: () => void;
      readonly onStopAndSpawn: () => void;
    }
  | { readonly kind: "start"; readonly onStart: () => void }
);

export function CakeDropDialog(props: CakeDropDialogProps) {
  const avatar = <CakeHashvatar cake={props.cake} size={16} className="align-text-bottom" />;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        {props.kind === "start" ? (
          <>
            <DialogHeader>
              <DialogTitle>
                <CakeStartQuestion cakeName={props.cake.name} avatar={avatar} />
              </DialogTitle>
              <DialogDescription>
                This attaches the cake and starts its first run on this thread.
              </DialogDescription>
            </DialogHeader>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>An agent is already working here</DialogTitle>
              <DialogDescription>
                Choose where {props.cake.name} should run. Nothing starts until you pick one.
              </DialogDescription>
            </DialogHeader>
            <CakeDropChoices
              cakeName={props.cake.name}
              threadTitle={props.threadTitle}
              avatar={avatar}
              onFork={props.onFork}
              onStopAndSpawn={props.onStopAndSpawn}
            />
          </>
        )}
        <DialogFooter variant="bare">
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          {props.kind === "start" ? <CakeStartChoice onStart={props.onStart} /> : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
