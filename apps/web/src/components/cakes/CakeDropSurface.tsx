"use client";

import { CakeIcon } from "lucide-react";

import type { CakeDropEvent, CakeDropHandlers } from "./cakeDropHandlers.ts";

/**
 * The thread column as a place a cake can be dropped.
 *
 * Split out of `ChatView` for the same reason `CakeShelfRowActions` was split
 * out of the shelf: the affordance is pure presentation over props, but it was
 * living inside a component that cannot be mounted, so the one thing worth
 * checking — that the user is told the drop will land — was uncheckable.
 *
 * The element it renders is shared with the workspace file drop, so the host
 * keeps its own class names, attributes and drag handlers and this only adds
 * the cake half.
 */

interface DragEventHandlers<TEvent> {
  onDragEnter(event: TEvent): void;
  onDragOver(event: TEvent): void;
  onDragLeave(event: TEvent): void;
  onDrop(event: TEvent): void;
}

// Written out rather than `Partial<…>` because a host that simply has no file
// drop handler passes an explicit `undefined` under exactOptionalPropertyTypes.
type OptionalDragEventHandlers<TEvent> = {
  readonly [K in keyof DragEventHandlers<TEvent>]?: DragEventHandlers<TEvent>[K] | undefined;
};

/**
 * Cake first, host second, on every drag event.
 *
 * Order matters and is not cosmetic: the cake handlers stop propagation for a
 * cake drag, and the host's file-drop handlers must still see the events they
 * do claim. Exported because this ordering is the whole wiring, and calling it
 * is the only way to observe it without a DOM.
 */
export function composeCakeDropDragProps<TEvent extends CakeDropEvent>(
  cake: CakeDropHandlers,
  host: OptionalDragEventHandlers<TEvent>,
): DragEventHandlers<TEvent> {
  return {
    onDragEnter(event) {
      cake.onDragEnter(event);
      host.onDragEnter?.(event);
    },
    onDragOver(event) {
      cake.onDragOver(event);
      host.onDragOver?.(event);
    },
    onDragLeave(event) {
      cake.onDragLeave(event);
      host.onDragLeave?.(event);
    },
    onDrop(event) {
      cake.onDrop(event);
      host.onDrop?.(event);
    },
  };
}

export type CakeDropSurfaceProps = React.ComponentPropsWithoutRef<"div"> & {
  /** True while a cake is being dragged over this surface. */
  readonly dragActive: boolean;
  readonly handlers: CakeDropHandlers;
};

export function CakeDropSurface({
  dragActive,
  handlers,
  children,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  ...containerProps
}: CakeDropSurfaceProps): React.JSX.Element {
  const dragProps = composeCakeDropDragProps<React.DragEvent<HTMLDivElement>>(handlers, {
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  });

  return (
    <div {...containerProps} {...dragProps}>
      {dragActive ? (
        <div
          className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
          data-chat-cake-drop-overlay="true"
        >
          <div
            role="status"
            className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
          >
            <CakeIcon className="size-4 text-primary" aria-hidden="true" />
            Drop to run this cake on the thread
          </div>
        </div>
      ) : null}
      {children}
    </div>
  );
}
