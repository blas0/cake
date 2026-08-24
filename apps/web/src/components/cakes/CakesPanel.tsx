"use client";

import type { CakeConfig, EnvironmentId } from "@t3tools/contracts";

import { cakesEnvironment } from "~/state/cakes";
import { useEnvironmentQuery } from "~/state/query";

import { ScrollArea } from "../ui/scroll-area";
import { CakeCreateIconButton } from "./CakeCreateIconButton";
import { CakeShelfEmptyState } from "./CakeShelfEmptyState";
import { useCakeEditor } from "./useCakeEditor";
import { setCakeDragGhost } from "./cakeDragGhost";
import { startCakeDrag } from "./cakeDragSource";
import { CakeShelfDragRow } from "./CakeShelfDragRow";
import { CakeHashvatar } from "./Hashvatar";
import { useCakeProviderDisplay } from "./useCakeProviderDisplay";

/**
 * The right panel's cake shelf: a palette to drag from.
 *
 * It lists each cake by avatar, provider and model. A row is draggable, and
 * dropping it on the thread or the composer attaches it there.
 *
 * It deliberately does nothing else *to a cake*. Running one, stopping it and
 * switching it off are all statements about one thread, and the shelf is not in
 * a thread — it is the same list whatever is open. Those controls live in the
 * composer's cake picker, which only ever lists cakes already attached to the
 * thread in front of the user. Rename, edit and delete stay with the cake here.
 *
 * Creating follows the same boundary: a new cake belongs to no thread, so it
 * starts here too.
 *
 * It wears two faces, chosen by whether the shelf has anything on it. Empty,
 * the panel's job is to explain itself, so the button goes under the
 * explanation and is spelled out: it is the answer to the sentence above it and
 * has to be read rather than recognised. With cakes listed, making another is
 * housekeeping, so it shrinks to an icon at the top of the panel and stays out
 * of the list's way.
 *
 * Both live inside the panel. An earlier attempt put the icon in the window's
 * control cluster beside Maximize, which is absolutely positioned over the
 * titlebar and overlaps the OS drag region — the button read as responding a
 * few pixels from where it was drawn. That cluster is also upstream's chrome
 * rather than this fork's, so it is the worse of the two places to diverge.
 */

function CakeShelfEntry({
  cake,
  onRename,
  onEdit,
  onDelete,
}: {
  readonly cake: CakeConfig;
  readonly onRename: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const provider = useCakeProviderDisplay(cake);

  return (
    <CakeShelfDragRow
      cakeId={cake.id}
      name={cake.name}
      driverKind={provider.driverKind}
      providerLabel={provider.providerLabel}
      modelLabel={provider.modelLabel}
      effortLabel={provider.effortLabel}
      avatar={<CakeHashvatar cake={cake} size={24} />}
      onDragStart={(event) => {
        // The payload first: if writing it fails there is nothing to carry, and
        // a styled chip for a drag that cannot be dropped is worse than none.
        if (!startCakeDrag(event, cake.id)) return;
        setCakeDragGhost(event.currentTarget, event.nativeEvent);
      }}
      onRename={onRename}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

export function CakesPanel({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const cakes = useEnvironmentQuery(
    environmentId === null ? null : cakesEnvironment.list({ environmentId, input: {} }),
  );
  const editor = useCakeEditor({ onChanged: cakes.refresh });
  const list = cakes.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        Above the list rather than scrolling with it: it is an action on the
        shelf, not an item in it, and a create button that scrolls out of reach
        once there are enough cakes to need one is the wrong way round.
      */}
      {list.length > 0 ? (
        <div className="flex justify-end px-2 pt-2">
          <CakeCreateIconButton onCreate={editor.openCreate} canCreate={editor.canOpen} />
        </div>
      ) : null}
      {cakes.error !== null ? (
        <p className="px-4 pt-3 pb-3 text-sm text-destructive-foreground">{cakes.error}</p>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pt-2 pb-3">
          {list.length === 0 && !cakes.isPending ? (
            <CakeShelfEmptyState onCreate={editor.openCreate} canCreate={editor.canOpen} />
          ) : (
            list.map((cake) => (
              <CakeShelfEntry
                key={cake.id}
                cake={cake}
                onRename={() => editor.openRename(cake)}
                onEdit={() => editor.openEdit(cake)}
                onDelete={() => editor.openDelete(cake)}
              />
            ))
          )}
        </div>
      </ScrollArea>
      {editor.dialog}
    </div>
  );
}
