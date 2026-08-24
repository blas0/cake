"use client";

import type { ReactNode } from "react";
import type { ProviderDriverKind } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { CakeShelfRowActions } from "../cakes/CakeShelfRowActions";
import type { CakeShelfModel, CakeShelfRow, CakeThreadStatus } from "../cakes/cakeThreadModel";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/**
 * One cake attached to this thread, as the composer's picker draws it.
 *
 * This is where a cake becomes actionable, because this is the only surface
 * that knows which thread the action lands in. The shelf in the right panel
 * shows the same cake without any of these controls on purpose.
 *
 * Presentational: the avatar arrives as a node and the provider strings are
 * already resolved, so the row can be rendered on its own in a test. That
 * matters most for the two icon-only controls, whose accessible names are the
 * only thing a user of a screen reader has to go on.
 */

/**
 * The name carries the state, so the row needs no separate status word.
 *
 * A live cake glimmers and an idle one goes grey — one channel, two ends of it,
 * which is what makes the picker readable at a glance instead of a list of
 * labels to compare. `scheduled` and `active` share the treatment deliberately:
 * from the user's side both mean "this is going to happen without me", and
 * splitting them would spend a third visual state on a distinction the next-run
 * line underneath already spells out.
 */
const NAME_CLASS: Record<CakeThreadStatus, string> = {
  active: "cake-glimmer",
  scheduled: "cake-glimmer",
  idle: "text-muted-foreground",
};

export function ComposerCakeRow({
  name,
  driverKind,
  providerLabel,
  avatar,
  row,
  shelf,
}: {
  readonly name: string;
  readonly driverKind: ProviderDriverKind;
  readonly providerLabel: string;
  readonly avatar: ReactNode;
  readonly row: CakeShelfRow;
  readonly shelf: CakeShelfModel;
}) {
  return (
    <div
      data-composer-cake-row={row.cakeId}
      className="flex min-w-56 items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent/60"
    >
      {avatar}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {/*
            The provider's mark leads, because it is the fixed part: every row
            here belongs to one thread, and what differs between them is whose
            agent is about to run. The model it will run on is not shown at all
            — the user chose it when they made the cake, and repeating it on
            every row spends the width that the cake's own name needs.
          */}
          <ProviderInstanceIcon
            driverKind={driverKind}
            displayName={providerLabel}
            iconClassName="size-4"
          />
          <span className={cn("min-w-0 truncate text-sm font-medium", NAME_CLASS[row.status])}>
            {name}
          </span>
        </div>
        <span className="truncate text-xs text-muted-foreground">{row.nextRunLabel}</span>
      </div>
      <CakeShelfRowActions cakeName={name} row={row} shelf={shelf} />
    </div>
  );
}
