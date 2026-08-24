import { cakeIdFromTransfer, dataTransferHasCake } from "./cakeDrag.ts";
import { decideCakeDrop, type CakeDropDecision } from "./cakeDropDecision.ts";

/**
 * Receiving a dragged cake on the thread container and on the composer.
 *
 * Headless in the shape `chat/workspaceFileDrop.ts` uses, for the same reason:
 * both of those elements already accept OS file drops, file mentions and text
 * selections, so the interesting behaviour is which drags this handler claims
 * and which it must leave completely untouched. That is not something a
 * component can be asked about, so it lives here.
 *
 * The decision itself is `decideCakeDrop`'s and is not re-derived.
 */

export interface CakeDropTransfer {
  readonly types: ReadonlyArray<string>;
  getData(format: string): string;
  dropEffect: string;
}

export interface CakeDropEvent {
  readonly dataTransfer: CakeDropTransfer;
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: { contains(target: Node | null): boolean };
  readonly nativeEvent: { stopPropagation(): void };
  preventDefault(): void;
  stopPropagation(): void;
}

export interface CakeDropHost {
  /** Read at drop time, not at mount: a turn can start while the drag is in flight. */
  readThread(): {
    readonly threadId: string | null;
    readonly threadHasStarted: boolean;
    readonly threadIsBusy: boolean;
  };
  setDragActive(active: boolean): void;
  /** An ignored drop is not the host's business. */
  onDecision(decision: Exclude<CakeDropDecision, { kind: "ignore" }>): void;
}

export interface CakeDropHandlers {
  onDragEnter(event: CakeDropEvent): void;
  onDragOver(event: CakeDropEvent): void;
  onDragLeave(event: CakeDropEvent): void;
  onDrop(event: CakeDropEvent): void;
}

export function makeCakeDropHandlers(host: CakeDropHost): CakeDropHandlers {
  // Claim the drag for the cake target. React's stopPropagation only halts the
  // synthetic dispatch, so the native event has to be stopped too or the
  // composer's own DOM listeners still process it — the same trap
  // `composerMentionDrag.ts` documents next door.
  const claim = (event: CakeDropEvent): boolean => {
    if (!dataTransferHasCake(event.dataTransfer.types)) return false;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopPropagation();
    return true;
  };

  const movedWithinTarget = (event: CakeDropEvent): boolean =>
    event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node);

  return {
    onDragEnter(event) {
      if (!claim(event)) return;
      if (movedWithinTarget(event)) return;
      host.setDragActive(true);
    },
    onDragOver(event) {
      if (!claim(event)) return;
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDragLeave(event) {
      if (!claim(event)) return;
      // Crossing a child fires dragleave on the parent; dropping the highlight
      // there makes it strobe as the pointer moves across the transcript.
      if (movedWithinTarget(event)) return;
      host.setDragActive(false);
    },
    onDrop(event) {
      if (!claim(event)) return;
      host.setDragActive(false);
      const thread = host.readThread();
      const decision = decideCakeDrop({
        cakeId: cakeIdFromTransfer(event.dataTransfer),
        threadId: thread.threadId,
        threadHasStarted: thread.threadHasStarted,
        threadIsBusy: thread.threadIsBusy,
      });
      if (decision.kind === "ignore") return;
      host.onDecision(decision);
    },
  };
}
