"use client";

import type { DragEvent, ReactNode } from "react";
import type { ProviderDriverKind } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { CakeShelfItemActions } from "./CakeShelfItemActions";

/**
 * One row of the shelf: a cake you can pick up.
 *
 * Running, stopping and switching a cake off are instructions about a thread,
 * so those controls live on the composer's picker. Rename, edit and delete act
 * on the cake itself and live here, at the trailing edge of its row.
 *
 * Presentational so that the absence of those controls is assertable: it takes
 * no atoms and no queries.
 */
export function CakeShelfDragRow({
  cakeId,
  name,
  driverKind,
  providerLabel,
  modelLabel,
  effortLabel,
  avatar,
  onDragStart,
  onRename,
  onEdit,
  onDelete,
}: {
  readonly cakeId: string;
  readonly name: string;
  readonly driverKind: ProviderDriverKind;
  readonly providerLabel: string;
  readonly modelLabel: string;
  /** Empty when the model has no effort ladder; the brackets go with it. */
  readonly effortLabel: string;
  readonly avatar: ReactNode;
  readonly onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  readonly onRename: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      data-cake-shelf-row={cakeId}
      className={cn(
        "flex cursor-grab items-center gap-2 rounded-lg px-2 py-2 active:cursor-grabbing",
        "hover:bg-accent/60",
      )}
    >
      {avatar}
      {/*
        Two lines: what this cake is, then what it runs on. The identity — face,
        provider mark, name — reads across the top as one phrase, and the
        configuration sits under it in the quieter colour, because when you are
        looking for a cake to pick up you are looking for its name.
      */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <ProviderInstanceIcon
            driverKind={driverKind}
            displayName={providerLabel}
            iconClassName="size-4"
          />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
        </div>
        <span className="truncate text-xs text-muted-foreground">
          {effortLabel.length === 0 ? modelLabel : `${modelLabel} (${effortLabel})`}
        </span>
      </div>
      <CakeShelfItemActions
        cakeName={name}
        onRename={onRename}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}
