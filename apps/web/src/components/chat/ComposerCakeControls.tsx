"use client";

import type { CakeConfig } from "@t3tools/contracts";
import { CakeIcon } from "lucide-react";

import { CakeHashvatar } from "../cakes/Hashvatar";
import { useCakeProviderDisplay } from "../cakes/useCakeProviderDisplay";
import {
  deriveCakeShelfRow,
  type CakeShelfModel,
  type CakeThreadEntry,
} from "../cakes/cakeThreadModel";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import { ComposerCakeRow } from "./ComposerCakeRow";

/**
 * The composer's cake controls: which cakes are live on this thread, what each
 * one is about to do, and the two ways to intervene.
 *
 * The picker is the only surface that is standing in a thread, so it is the
 * only one that offers Run now, Stop and the lock. The right panel's shelf is
 * the same cakes with none of that — it is a palette you drag from.
 *
 * Everything decidable is decided in `cakes/cakeThreadModel.ts`, which can be
 * tested; this file is the design system's own primitives arranged around it.
 */

export interface ComposerCakesModel {
  readonly entries: ReadonlyArray<CakeThreadEntry>;
  /** The full configs, for the avatar and the model a row names. */
  readonly cakes: ReadonlyArray<CakeConfig>;
  /**
   * Null off a thread. Every control on a row is an instruction about running
   * this cake *here*, so without a thread there is nothing to instruct.
   */
  readonly shelf: CakeShelfModel | null;
  readonly onSetCakeEnabled: (cakeId: string, enabled: boolean) => void;
  readonly onStopCake: () => void;
}

const STATUS_LABEL: Record<CakeThreadEntry["status"], string> = {
  active: "Running now",
  scheduled: "Scheduled",
  idle: "Off",
};

function ComposerCakeEntry({
  cake,
  shelf,
  nowMs,
}: {
  readonly cake: CakeConfig;
  readonly shelf: CakeShelfModel;
  readonly nowMs: number;
}) {
  const provider = useCakeProviderDisplay(cake);

  return (
    <ComposerCakeRow
      name={cake.name}
      driverKind={provider.driverKind}
      providerLabel={provider.providerLabel}
      avatar={<CakeHashvatar cake={cake} size={24} />}
      row={deriveCakeShelfRow({
        cakeId: cake.id,
        attachments: shelf.attachments,
        runningCakeId: shelf.runningCakeId,
        nowMs,
      })}
      shelf={shelf}
    />
  );
}

/**
 * Shown only when at least one cake is attached to this thread — idle,
 * scheduled or active. An empty picker in the footer of every thread would be
 * a permanent control for a feature most threads never use.
 */
export function ComposerCakesSelect({ model }: { readonly model: ComposerCakesModel }) {
  // Read once per render, so every row answers "today" against the same
  // instant. `formatCakeNextRun` takes it as an argument for exactly that.
  const nowMs = Date.now();
  const shelf = model.shelf;
  const attached = model.entries.flatMap((entry) => {
    const cake = model.cakes.find((candidate) => candidate.id === entry.cakeId);
    return cake === undefined ? [] : [cake];
  });

  return (
    <Popover>
      <PopoverTrigger
        render={<ComposerControl type="button" className="font-medium" aria-label="Cakes" />}
      >
        <ComposerControlIcon icon={CakeIcon} />
        {/*
          The control names the thing it opens rather than counting it. A tally
          in the footer read as a badge demanding attention, and the per-cake
          state it summarised is a row away in the popup.
        */}
        <Tooltip>
          <TooltipTrigger render={<span />}>Cakes</TooltipTrigger>
          <TooltipPopup side="top">Cakes attached to this thread</TooltipPopup>
        </Tooltip>
        <ComposerControlChevron />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" viewportClassName="p-1 [--viewport-inline-padding:0]">
        <div className="flex flex-col gap-0.5">
          {shelf === null || attached.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No cakes are attached to this thread.
            </p>
          ) : (
            attached.map((cake) => (
              <ComposerCakeEntry key={cake.id} cake={cake} shelf={shelf} nowMs={nowMs} />
            ))
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** The compact footer shows the same statuses inside a menu. */
export { STATUS_LABEL as COMPOSER_CAKE_STATUS_LABEL };
