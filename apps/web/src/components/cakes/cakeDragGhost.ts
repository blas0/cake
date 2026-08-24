/**
 * What a cake looks like while it is in the air.
 *
 * Without this the browser snapshots the shelf row as it stands, and that row
 * is deliberately transparent — it has a radius but no surface of its own, so
 * the sidebar reads as a list rather than a stack of cards. Snapshotted, the
 * transparency is composited against nothing and the radius has no background
 * to clip, so what the user picks up is a hard white rectangle: the "rough
 * un-styled button" the shelf never shows while sitting still.
 *
 * So the drag gets its own surface. A clone rather than the row itself,
 * because the row must not change while a copy of it is being carried, and
 * because the ghost wants a background, a border and a shadow that would be
 * wrong in the list.
 *
 * The avatar is a canvas, and `cloneNode` copies the element without its
 * pixels — a cloned hashvatar is blank. Its bitmap is copied across
 * explicitly, and if that fails the ghost is still a correct chip with an
 * empty avatar rather than no drag image at all.
 *
 * Untested by unit test on purpose: this repo's test stack has no DOM, and
 * every claim here — that the chip is opaque, that the avatar survives the
 * clone, that the ghost does not linger — is a claim about a real renderer.
 * It is verified by dragging a cake.
 */

/**
 * A card being carried, not a row in a list. `bg-popover` and the shadow are
 * the same pairing every floating surface in the app uses; the radius matches
 * the row it came from so the chip reads as that row lifted off the page.
 */
const GHOST_CLASS =
  "pointer-events-none fixed left-0 z-50 flex w-max max-w-96 items-center gap-2 rounded-lg " +
  "border border-border bg-popover px-2.5 py-2 shadow-lg";

/** Far enough off-screen that it is never seen, still laid out so it renders. */
const OFFSCREEN_TOP = "-10000px";

function copyCanvasPixels(source: Element, ghost: Element): void {
  const sourceCanvases = source.querySelectorAll("canvas");
  const ghostCanvases = ghost.querySelectorAll("canvas");

  sourceCanvases.forEach((original, index) => {
    const copy = ghostCanvases[index];
    if (copy === undefined) return;
    try {
      copy.getContext("2d")?.drawImage(original, 0, 0);
    } catch {
      // A tainted or context-less canvas is not worth losing the drag over.
    }
  });
}

/**
 * What the ghost needs from the drag: where the cursor is, and what to hand the
 * image to.
 *
 * Narrowed rather than taking a `DragEvent`, because the row must be passed in
 * separately and a signature that also accepted the event's own target would
 * invite reading it from there. React dispatches at the root container, so a
 * native `currentTarget` is the whole app — cloning it produced a drag image of
 * the entire window, which is how this was found.
 */
export interface CakeDragGhostEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly dataTransfer: DataTransfer | null;
}

/**
 * Gives the drag a styled chip to carry, positioned under the cursor.
 *
 * `row` is the element to copy — the caller's own `currentTarget`, which under
 * React is the row and under a raw listener would have to be passed anyway.
 *
 * Returns whether one was set, so a caller can tell the no-op cases apart from
 * a real failure — though nothing depends on it today, and nothing should:
 * losing the custom image only costs appearance, and the drag itself still
 * carries its payload.
 */
export function setCakeDragGhost(row: HTMLElement, event: CakeDragGhostEvent): boolean {
  const transfer = event.dataTransfer;
  if (transfer === null || typeof transfer.setDragImage !== "function") return false;

  const ghost = row.cloneNode(true);
  if (!(ghost instanceof HTMLElement)) return false;

  // The clone is a chip now, not a row: everything the list gave it — the grab
  // cursor, the hover surface, the row's own layout — is replaced outright so
  // no leftover class from the shelf survives into the drag.
  ghost.className = GHOST_CLASS;
  ghost.removeAttribute("draggable");
  ghost.style.top = OFFSCREEN_TOP;

  document.body.appendChild(ghost);
  copyCanvasPixels(row, ghost);

  // Held where it was grabbed, so the chip stays under the cursor instead of
  // jumping to a corner the moment the drag begins.
  const bounds = row.getBoundingClientRect();
  transfer.setDragImage(ghost, event.clientX - bounds.left, event.clientY - bounds.top);

  // The snapshot is taken once the dragstart handler returns, so the node has
  // to outlive this function by exactly one frame and no longer.
  requestAnimationFrame(() => {
    ghost.remove();
  });

  return true;
}
