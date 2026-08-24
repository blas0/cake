"use client";

import { useAtomValue } from "@effect/atom-react";
import { useCallback, useState, type ReactNode } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { CakeId, ProviderDriverKind, type CakeConfig } from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";
import { getDefaultServerModel, getProviderModels } from "~/providerModels";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { cakesEnvironment } from "~/state/cakes";
import { useAtomCommand } from "~/state/use-atom-command";
import { primaryServerProvidersAtom } from "~/state/server";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { CakeFormDialog } from "./CakeFormDialog";
import {
  cakeDraftToInput,
  cakeToDraft,
  defaultEffortOptionId,
  newCakeDraft,
  resolveEffortOptions,
  resolveSystemTimeZone,
  type CakeDraft,
} from "./CakeFormDialog.logic";

/**
 * Writing a cake, wherever the user starts from.
 *
 * The shelf opens this dialog for create, rename, edit and delete. Keeping the
 * draft state and writes here gives each entry point the same failure handling
 * and confirmation behavior.
 *
 * `onChanged` rather than a shared query refresh: each surface reads its own
 * list, and the hook has no business knowing which.
 */

/**
 * Branded once, here, rather than at each use.
 *
 * It used to be branded on the line that looked up the model and passed raw
 * into the draft three lines below — the same value with two typings, which is
 * the mixed style the brand exists to prevent.
 */
const DEFAULT_PROVIDER_KIND = ProviderDriverKind.make("claudeAgent");

interface DialogState {
  readonly mode: "create" | "edit";
  readonly draft: CakeDraft;
  readonly autoFocusName: boolean;
  readonly confirmDeleteInitially: boolean;
}

export interface CakeEditor {
  /** False before an environment is known — there is nowhere to save a cake. */
  readonly canOpen: boolean;
  readonly openCreate: () => void;
  readonly openEdit: (cake: CakeConfig) => void;
  readonly openRename: (cake: CakeConfig) => void;
  readonly openDelete: (cake: CakeConfig) => void;
  /**
   * The dialog, or null while it is closed.
   *
   * Returned as a node rather than as props because there is exactly one right
   * way to render it, and handing the caller a bag of props invites two
   * surfaces to render it two ways.
   */
  readonly dialog: ReactNode;
}

export function useCakeEditor({ onChanged }: { readonly onChanged: () => void }): CakeEditor {
  const environmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const upsertCake = useAtomCommand(cakesEnvironment.upsert, { reportFailure: false });
  const deleteCake = useAtomCommand(cakesEnvironment.remove, { reportFailure: false });
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // The default command reporter writes to the console, which for a save the
  // user is watching is the same as saying nothing. A failed write keeps the
  // dialog open with the draft intact and says why.
  const reportFailure = useCallback(
    (title: string, result: AtomCommandResult<void, unknown>): boolean => {
      if (result._tag !== "Failure") return false;
      if (isAtomCommandInterrupted(result)) return true;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return true;
    },
    [],
  );

  const openCreate = useCallback(() => {
    const model = getDefaultServerModel(providers, DEFAULT_PROVIDER_KIND);
    // The provider's declared default, not whichever option happens to be
    // listed first — see `defaultEffortOptionId`.
    const effort = defaultEffortOptionId(
      resolveEffortOptions(
        getProviderModels(providers, DEFAULT_PROVIDER_KIND).find(
          (candidate) => candidate.slug === model,
        )?.capabilities?.optionDescriptors,
      ),
    );
    setDialog({
      mode: "create",
      autoFocusName: false,
      confirmDeleteInitially: false,
      draft: newCakeDraft({
        id: `cake_${randomUUID()}`,
        timeZone: resolveSystemTimeZone(),
        providerKind: DEFAULT_PROVIDER_KIND,
        model,
        effort,
      }),
    });
  }, [providers]);

  const openEdit = useCallback((cake: CakeConfig) => {
    setDialog({
      mode: "edit",
      draft: cakeToDraft(cake, resolveSystemTimeZone()),
      autoFocusName: false,
      confirmDeleteInitially: false,
    });
  }, []);

  const openRename = useCallback((cake: CakeConfig) => {
    setDialog({
      mode: "edit",
      draft: cakeToDraft(cake, resolveSystemTimeZone()),
      autoFocusName: true,
      confirmDeleteInitially: false,
    });
  }, []);

  const openDelete = useCallback((cake: CakeConfig) => {
    setDialog({
      mode: "edit",
      draft: cakeToDraft(cake, resolveSystemTimeZone()),
      autoFocusName: false,
      confirmDeleteInitially: true,
    });
  }, []);

  const submit = useCallback(async () => {
    if (dialog === null || environmentId === null) return;
    setIsSaving(true);
    const result = await upsertCake({
      environmentId,
      input: { cake: cakeDraftToInput(dialog.draft) },
    });
    setIsSaving(false);
    if (reportFailure("Failed to save cake", result)) return;
    setDialog(null);
    onChanged();
  }, [dialog, environmentId, onChanged, reportFailure, upsertCake]);

  const remove = useCallback(async () => {
    if (dialog === null || environmentId === null) return;
    setIsSaving(true);
    const result = await deleteCake({
      environmentId,
      input: { cakeId: CakeId.make(dialog.draft.id) },
    });
    setIsSaving(false);
    if (reportFailure("Failed to delete cake", result)) return;
    setDialog(null);
    onChanged();
  }, [deleteCake, dialog, environmentId, onChanged, reportFailure]);

  return {
    canOpen: environmentId !== null,
    openCreate,
    openEdit,
    openRename,
    openDelete,
    dialog:
      dialog === null ? null : (
        <CakeFormDialog
          open
          mode={dialog.mode}
          draft={dialog.draft}
          isSaving={isSaving}
          onDraftChange={(draft) => {
            setDialog({ ...dialog, draft });
          }}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onSubmit={() => void submit()}
          onDelete={() => void remove()}
          autoFocusName={dialog.autoFocusName}
          confirmDeleteInitially={dialog.confirmDeleteInitially}
        />
      ),
  };
}
