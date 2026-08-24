"use client";

import { Button } from "../ui/button";

export function CakeDeleteConfirmation({
  cakeName,
  isSaving,
  onCancel,
  onConfirm,
}: {
  readonly cakeName: string;
  readonly isSaving: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium text-foreground">Delete "{cakeName}"?</p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" disabled={isSaving} onClick={onCancel}>
          Keep cake
        </Button>
        <Button type="button" variant="destructive" disabled={isSaving} onClick={onConfirm}>
          Delete cake
        </Button>
      </div>
    </div>
  );
}
