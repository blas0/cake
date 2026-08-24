"use client";

import { PlusIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Create a cake, once there are cakes to create another one alongside.
 *
 * Icon only, because by this point the user knows what a cake is and where they
 * live: making another is housekeeping, and the words are no longer doing any
 * work. It keeps the filled primary treatment and size of the labeled action in
 * the empty shelf. Only the label drops away here.
 *
 * It lives at the top of the panel rather than in the window's control cluster
 * beside Maximize. That cluster is absolutely positioned over the titlebar and
 * overlaps the OS drag region, so a button placed there reads as sitting a few
 * pixels away from where it responds. It is also upstream's chrome rather than
 * this fork's, which makes it the worse of the two places to diverge.
 *
 * Presentational so that "icon only" is something a test can hold on to.
 */
export function CakeCreateIconButton({
  onCreate,
  canCreate,
}: {
  readonly onCreate: () => void;
  readonly canCreate: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            // The default variant matches the labeled empty-shelf action.
            //
            // `--control-icon-color:currentColor` because the button base paints
            // icons from that variable rather than from the text colour, so
            // without it the white `text-primary-foreground` the fill needs to
            // be legible against never reaches the glyph.
            className="shrink-0 [--control-icon-color:currentColor]"
            aria-label="Create a Cake"
            onClick={onCreate}
            disabled={!canCreate}
          >
            <PlusIcon className="size-4" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">Create a Cake</TooltipPopup>
    </Tooltip>
  );
}
