import { CAKE_DRAG_TYPE, serializeCakeDrag } from "./cakeDrag.ts";

/**
 * Tagging a cake row's drag with the payload the thread reads back.
 *
 * The sending half of the idiom the file tree uses for mentions
 * (`files/fileTreeDragMention.ts`): the source writes one custom MIME type and
 * nothing else, so a drop target can tell a cake from an OS file, a file
 * mention or a dragged text selection by looking at `types` alone.
 */

export interface CakeDragStartTransfer {
  setData(format: string, data: string): void;
  effectAllowed: string;
}

export interface CakeDragStartEvent {
  readonly dataTransfer: CakeDragStartTransfer | null;
}

/**
 * Writes the cake onto the drag, or refuses. Returns whether it wrote.
 *
 * The refusals matter more than the write: this payload ends up starting an
 * unattended agent, so an id that is blank never becomes a drag at all rather
 * than becoming one the receiver has to reject later.
 */
export function startCakeDrag(event: CakeDragStartEvent, cakeId: string): boolean {
  if (event.dataTransfer === null) return false;
  if (cakeId.trim().length === 0) return false;

  // The drop handler names "copy"; a source that allows only "move" makes the
  // browser cancel the drop without firing it.
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(CAKE_DRAG_TYPE, serializeCakeDrag(cakeId));
  return true;
}
