"use client";

import { LockIcon, LockOpenIcon, OctagonXIcon, PlayIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { CakeShelfModel, CakeShelfRow } from "./cakeThreadModel";

/**
 * The two things a row lets you do, as icons.
 *
 * Split out from the row because it is the one part of the shelf that can be
 * rendered on its own: it takes no atoms and no queries, so the accessible
 * names of icon-only controls are checkable rather than asserted by eye.
 */
export function CakeShelfRowActions({
  cakeName,
  row,
  shelf,
}: {
  readonly cakeName: string;
  readonly row: CakeShelfRow;
  readonly shelf: CakeShelfModel;
}) {
  const lockLabel = row.enabled ? `Disable ${cakeName}` : `Enable ${cakeName}`;

  return (
    <div className="flex shrink-0 items-center gap-0.5 self-center">
      {row.isRunning ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Stop ${cakeName}`}
                onClick={shelf.onStop}
              />
            }
          >
            <OctagonXIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top">Stop {cakeName}</TooltipPopup>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Run ${cakeName} now`}
                onClick={() => {
                  shelf.onRunNow(row.cakeId);
                }}
              />
            }
          >
            <PlayIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top">Run {cakeName} now</TooltipPopup>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={lockLabel}
              onClick={() => {
                shelf.onSetEnabled(row.cakeId, !row.enabled);
              }}
            />
          }
        >
          {/* Locked is the stopped state: locking is what the disabling does. */}
          {row.enabled ? <LockOpenIcon aria-hidden /> : <LockIcon aria-hidden />}
        </TooltipTrigger>
        <TooltipPopup side="top">{lockLabel}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
