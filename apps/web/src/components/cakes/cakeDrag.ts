/**
 * Dragging a cake onto a thread.
 *
 * Its own MIME type, following the file-mention drag next door. That matters
 * more here than it does there: the same container also accepts OS file drops,
 * file-tree mentions and plain text selections, and a drop handler that guesses
 * would start an unattended agent from a stray selection.
 */

export const CAKE_DRAG_TYPE = "application/x-t3code-cake";

export function serializeCakeDrag(cakeId: string): string {
  return JSON.stringify({ cakeId });
}

export function dataTransferHasCake(types: ReadonlyArray<string>): boolean {
  return types.includes(CAKE_DRAG_TYPE);
}

export interface CakeDragTransfer {
  readonly types: ReadonlyArray<string>;
  getData(format: string): string;
}

/**
 * The cake id a drag carries, or null.
 *
 * Anything can write to a drag transfer and this id goes straight into a call
 * that starts an agent, so a malformed payload returns null rather than being
 * passed along and failing somewhere less obvious.
 */
export function cakeIdFromTransfer(transfer: CakeDragTransfer): string | null {
  if (!dataTransferHasCake(transfer.types)) return null;

  const raw = transfer.getData(CAKE_DRAG_TYPE);
  if (raw.length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const cakeId = (parsed as { cakeId?: unknown }).cakeId;
    return typeof cakeId === "string" && cakeId.trim().length > 0 ? cakeId : null;
  } catch {
    return null;
  }
}
