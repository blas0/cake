"use client";

import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { CakeForm } from "./CakeForm";
import { type CakeDraft } from "./CakeFormDialog.logic";

/**
 * The dialog a cake is written in.
 *
 * Chrome only: the fields live in `CakeForm`, which is mountable on its own.
 */
export function CakeFormDialog({
  open,
  mode,
  draft,
  onDraftChange,
  onOpenChange,
  onSubmit,
  onDelete,
  isSaving,
  autoFocusName = false,
  confirmDeleteInitially = false,
}: {
  readonly open: boolean;
  readonly mode: "create" | "edit";
  readonly draft: CakeDraft;
  readonly onDraftChange: (next: CakeDraft) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: () => void;
  readonly onDelete: () => void;
  readonly isSaving: boolean;
  readonly autoFocusName?: boolean;
  readonly confirmDeleteInitially?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create a Cake" : "Edit Cake"}</DialogTitle>
          <DialogDescription>
            A cake runs its instructions on a schedule, unattended, at full permission.
          </DialogDescription>
        </DialogHeader>

        <CakeForm
          mode={mode}
          draft={draft}
          onDraftChange={onDraftChange}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
          onDelete={onDelete}
          isSaving={isSaving}
          autoFocusName={autoFocusName}
          confirmDeleteInitially={confirmDeleteInitially}
        />
      </DialogPopup>
    </Dialog>
  );
}
