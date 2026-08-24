"use client";

import { CakeIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

/**
 * The shelf with nothing on it.
 *
 * Presentational, and separate from the panel, because the panel reads a query
 * and cannot be rendered in this repo's test stack — which would leave the one
 * surface whose entire job is explanation with nothing checking what it says.
 *
 * The button is spelled out and carries no icon. It is the answer to the
 * sentence above it, so it has to be read rather than recognised; an icon here
 * would be a smaller, quieter version of the thing the panel is trying to say.
 * Once cakes exist the same action moves to an icon in the panel's header,
 * where it is housekeeping instead — see `CakeCreateHeaderButton`.
 */
export function CakeShelfEmptyState({
  onCreate,
  canCreate,
}: {
  readonly onCreate: () => void;
  readonly canCreate: boolean;
}) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <CakeIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No cakes yet</EmptyTitle>
        <EmptyDescription>
          A cake is a saved agent loop. Create one, then drag it from here onto an active thread to
          start.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" onClick={onCreate} disabled={!canCreate}>
          Create a Cake
        </Button>
      </EmptyContent>
    </Empty>
  );
}
