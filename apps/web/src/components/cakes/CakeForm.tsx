"use client";

import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  CAKE_ANCHOR_CADENCES,
  CAKE_INTERVAL_UNITS,
  ProviderDriverKind,
  type CakeAnchorCadence,
  type CakeIntervalUnit,
} from "@t3tools/contracts";

import { getProviderModels } from "~/providerModels";
import { primaryServerProvidersAtom } from "~/state/server";
import { cn } from "~/lib/utils";
import { AVAILABLE_PROVIDER_OPTIONS } from "../chat/providerIconUtils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { DialogFooter, DialogPanel } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { CakeDeleteConfirmation } from "./CakeDeleteConfirmation";
import {
  cakeScheduleFields,
  canSubmitCakeDraft,
  formatToolList,
  parseToolList,
  reconcileEffort,
  resolveEffortOptions,
  shownCakeDraftErrors,
  toolEnforcementNote,
  editCakeField,
  touchCakeField,
  touchCakeSubmit,
  UNTOUCHED_CAKE_FORM,
  type CakeDraft,
  type CakeDraftField,
  type CakeFormTouch,
  type CakeScheduleMode,
  type Meridiem,
} from "./CakeFormDialog.logic";

/**
 * The cake form itself, without the dialog around it.
 *
 * Split from `CakeFormDialog` for the reason `CakeShelfRowActions` was split
 * from the shelf: a Base UI dialog puts its popup in a portal, so the fields
 * exist only once a browser has mounted one. On their own they are ordinary
 * markup, which is what makes "does the anchored mode actually draw an hour
 * picker" a question a test can ask rather than one a person has to click
 * through. The dialog keeps the chrome; this keeps the form.
 */

const SCHEDULE_MODE_LABELS: Readonly<Record<CakeScheduleMode, string>> = {
  every: "Run every…",
  at: "Run on a schedule…",
};

const SCHEDULE_MODES: ReadonlyArray<CakeScheduleMode> = ["every", "at"];

/**
 * Plural on their own, because the count sits in a field beside them rather
 * than in the label. "Every 1 minutes" reads badly for exactly one value out of
 * every sixty; a singular form would read badly for the other fifty-nine.
 */
const INTERVAL_UNIT_LABELS: Readonly<Record<CakeIntervalUnit, string>> = {
  second: "seconds",
  minute: "minutes",
  hour: "hours",
  day: "days",
  week: "weeks",
  month: "months",
};

const ANCHOR_CADENCE_LABELS: Readonly<Record<CakeAnchorCadence, string>> = {
  day: "day",
  week: "week",
  "bi-weekly": "two weeks",
  month: "month",
};

const HOURS_12 = Array.from({ length: 12 }, (_, index) => index + 1);
const MERIDIEMS: ReadonlyArray<Meridiem> = ["AM", "PM"];

/**
 * A schedule control is as wide as the word it holds.
 *
 * `SelectTrigger` is built for selects that own a column, so it defaults to
 * `w-full min-w-36`. The schedule controls own no column: they are the words of
 * one sentence, and a 144px floor under "9" and under "AM" is what made the row
 * wider than the dialog and stranded the meridiem on a line of its own. `w-auto`
 * sizes each control to its own longest value; `min-w-0` takes the floor away so
 * `w-auto` is actually honoured, and also lets a control give ground on a narrow
 * phone sheet rather than pushing the sentence apart again.
 */
const SCHEDULE_SELECT_CLASS = "w-auto min-w-0";

function FormField({
  label,
  htmlFor,
  description,
  error,
  children,
  className,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly description?: ReactNode;
  readonly error?: string | undefined;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

export function CakeForm({
  mode,
  draft,
  onDraftChange,
  onCancel,
  onSubmit,
  onDelete,
  isSaving,
  autoFocusName = false,
  confirmDeleteInitially = false,
  initialTouch = UNTOUCHED_CAKE_FORM,
}: {
  readonly mode: "create" | "edit";
  readonly draft: CakeDraft;
  readonly onDraftChange: (next: CakeDraft) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly onDelete: () => void;
  readonly isSaving: boolean;
  readonly autoFocusName?: boolean;
  readonly confirmDeleteInitially?: boolean;
  /**
   * Which fields start out already accused, defaulting to none.
   *
   * Whether a field has been visited is this component's own business — nothing
   * outside it can observe a blur — so the state lives here and the parent is
   * unchanged. The seed exists because "already visited" is otherwise only
   * reachable by clicking, and this form is tested by rendering.
   */
  readonly initialTouch?: CakeFormTouch;
}) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const driverKind = ProviderDriverKind.make(draft.providerKind);
  const models = useMemo(() => getProviderModels(providers, driverKind), [driverKind, providers]);
  const effortOptions = useMemo(
    () =>
      resolveEffortOptions(
        models.find((model) => model.slug === draft.model)?.capabilities?.optionDescriptors,
      ),
    [draft.model, models],
  );
  const [touch, setTouch] = useState<CakeFormTouch>(initialTouch);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(confirmDeleteInitially);
  const errors = shownCakeDraftErrors(draft, touch);
  const scheduleFields = cakeScheduleFields(draft.scheduleMode);
  const toolNote = toolEnforcementNote(draft.providerKind);

  const patch = (next: Partial<CakeDraft>) => onDraftChange({ ...draft, ...next });
  const touchField = (field: CakeDraftField) =>
    setTouch((current) => touchCakeField(current, field));
  // Paired with `touchField`: editing arms the message, leaving fires it.
  const editField = (field: CakeDraftField) => setTouch((current) => editCakeField(current, field));

  // Changing the harness or the model can strip the effort ladder out from
  // under the current value, so both re-resolve it rather than leaving a stale
  // effort the new model has never heard of.
  const selectModel = (slug: string) => {
    const descriptors = models.find((model) => model.slug === slug)?.capabilities
      ?.optionDescriptors;
    patch({
      model: slug,
      effort: reconcileEffort(draft.effort, resolveEffortOptions(descriptors)),
    });
  };

  const selectProvider = (kind: string) => {
    const nextModels = getProviderModels(providers, ProviderDriverKind.make(kind));
    const nextModel =
      nextModels.find((model) => model.slug === draft.model)?.slug ??
      nextModels.find((model) => model.isDefault && !model.isCustom)?.slug ??
      nextModels[0]?.slug ??
      "";
    const descriptors = nextModels.find((model) => model.slug === nextModel)?.capabilities
      ?.optionDescriptors;
    patch({
      providerKind: kind,
      model: nextModel,
      effort: reconcileEffort(draft.effort, resolveEffortOptions(descriptors)),
    });
  };

  return (
    <>
      <DialogPanel className="flex flex-col gap-5">
        <FormField label="Name" htmlFor="cake-name" error={errors.name}>
          <Input
            id="cake-name"
            autoFocus={autoFocusName}
            value={draft.name}
            placeholder="Nightly triage"
            aria-invalid={errors.name !== undefined}
            onBlur={() => touchField("name")}
            onChange={(event) => {
              editField("name");
              patch({ name: event.currentTarget.value });
            }}
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Harness">
            <Select
              value={draft.providerKind}
              onValueChange={(value) => selectProvider(String(value))}
            >
              <SelectTrigger aria-label="Harness">
                <SelectValue>
                  {AVAILABLE_PROVIDER_OPTIONS.find((option) => option.value === draft.providerKind)
                    ?.label ?? draft.providerKind}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {AVAILABLE_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex items-center gap-2">
                      <ProviderInstanceIcon
                        driverKind={option.value}
                        displayName={option.label}
                        iconClassName="size-4"
                      />
                      {option.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </FormField>

          <FormField label="Model" error={errors.model}>
            <Select
              value={draft.model}
              onValueChange={(value) => {
                touchField("model");
                selectModel(String(value));
              }}
            >
              <SelectTrigger aria-label="Model" aria-invalid={errors.model !== undefined}>
                <SelectValue>
                  {models.find((model) => model.slug === draft.model)?.name || draft.model || "—"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {models.map((model) => (
                  <SelectItem key={model.slug} value={model.slug}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </FormField>

          <FormField
            label="Effort"
            description={
              effortOptions.length === 0 ? "This model has no effort setting." : undefined
            }
          >
            <Select
              value={draft.effort}
              disabled={effortOptions.length === 0}
              onValueChange={(value) => patch({ effort: String(value) })}
            >
              <SelectTrigger aria-label="Effort">
                <SelectValue>
                  {effortOptions.find((option) => option.id === draft.effort)?.label ?? "—"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {effortOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </FormField>
        </div>

        <FormField
          label="Loop schedule"
          description={
            scheduleFields.showTimeOfDay
              ? `Times are in ${draft.timeZone}, your system timezone. Cakes run on the hour.`
              : "Counted from a fixed grid, so a late run never drags the next one later."
          }
          error={errors.intervalCount ?? errors.hour}
        >
          {/*
            One sentence, so one line. Wrapping is what broke this row in the
            first place — the meridiem fell off the end and the schedule read
            "…at 9" with "AM" underneath — so the row does not wrap at all and
            each control is sized by its contents instead.
          */}
          <div className="flex min-w-0 items-center gap-2">
            <Select
              value={draft.scheduleMode}
              onValueChange={(value) => patch({ scheduleMode: value as CakeScheduleMode })}
            >
              <SelectTrigger className={SCHEDULE_SELECT_CLASS} aria-label="Schedule mode">
                <SelectValue>{SCHEDULE_MODE_LABELS[draft.scheduleMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {SCHEDULE_MODES.map((scheduleMode) => (
                  <SelectItem key={scheduleMode} value={scheduleMode}>
                    {SCHEDULE_MODE_LABELS[scheduleMode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>

            {scheduleFields.showInterval ? (
              <>
                <Input
                  id="cake-interval-count"
                  className="w-20"
                  type="number"
                  min={1}
                  value={String(draft.intervalCount)}
                  aria-label="Interval count"
                  aria-invalid={errors.intervalCount !== undefined}
                  onBlur={() => touchField("intervalCount")}
                  onChange={(event) => {
                    editField("intervalCount");
                    patch({ intervalCount: Number(event.currentTarget.value) });
                  }}
                />
                <Select
                  value={draft.intervalUnit}
                  onValueChange={(value) => {
                    // The floor is a statement about count and unit together, and
                    // it is reported against the count, so changing either one is
                    // the user having had their chance to be wrong about it.
                    touchField("intervalCount");
                    patch({ intervalUnit: value as CakeIntervalUnit });
                  }}
                >
                  <SelectTrigger className={SCHEDULE_SELECT_CLASS} aria-label="Interval unit">
                    <SelectValue>{INTERVAL_UNIT_LABELS[draft.intervalUnit]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {CAKE_INTERVAL_UNITS.map((unit) => (
                      <SelectItem key={unit} value={unit}>
                        {INTERVAL_UNIT_LABELS[unit]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </>
            ) : null}

            {scheduleFields.showTimeOfDay ? (
              <>
                <span aria-hidden className="shrink-0 text-muted-foreground">
                  every
                </span>
                <Select
                  value={draft.anchorCadence}
                  onValueChange={(value) => patch({ anchorCadence: value as CakeAnchorCadence })}
                >
                  <SelectTrigger className={SCHEDULE_SELECT_CLASS} aria-label="Cadence">
                    <SelectValue>{ANCHOR_CADENCE_LABELS[draft.anchorCadence]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {CAKE_ANCHOR_CADENCES.map((cadence) => (
                      <SelectItem key={cadence} value={cadence}>
                        {ANCHOR_CADENCE_LABELS[cadence]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <span aria-hidden className="shrink-0 text-muted-foreground">
                  at
                </span>
                <Select
                  value={String(draft.hour12)}
                  onValueChange={(value) => {
                    touchField("hour");
                    patch({ hour12: Number(value) });
                  }}
                >
                  <SelectTrigger className={SCHEDULE_SELECT_CLASS} aria-label="Hour">
                    <SelectValue>{String(draft.hour12)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {HOURS_12.map((hour) => (
                      <SelectItem key={hour} value={String(hour)}>
                        {String(hour)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Select
                  value={draft.meridiem}
                  onValueChange={(value) => patch({ meridiem: value as Meridiem })}
                >
                  <SelectTrigger className={SCHEDULE_SELECT_CLASS} aria-label="AM or PM">
                    <SelectValue>{draft.meridiem}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {MERIDIEMS.map((meridiem) => (
                      <SelectItem key={meridiem} value={meridiem}>
                        {meridiem}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </>
            ) : null}
          </div>
        </FormField>

        {/*
          The note is an explanation, not an accusation. It was red, which is
          the colour this form uses to tell a user they have to fix something —
          and there is nothing to fix here: the list is unenforceable on every
          harness, whatever anyone types. So it is ordinary helper text, in the
          same muted treatment as the timezone line and the CAKE.md line, and
          the field it explains is visibly inert rather than merely inactive.
        */}
        <FormField
          label="Disallowed tools"
          htmlFor="cake-disallowed-tools"
          description={toolNote.note}
        >
          <Input
            id="cake-disallowed-tools"
            className={toolNote.enforced ? undefined : "cursor-not-allowed"}
            value={formatToolList(draft.disallowedTools)}
            placeholder={toolNote.enforced ? "Bash, WebFetch" : undefined}
            disabled={!toolNote.enforced}
            onChange={(event) =>
              patch({ disallowedTools: parseToolList(event.currentTarget.value) })
            }
          />
        </FormField>

        <FormField
          label="CAKE.md"
          htmlFor="cake-instructions"
          description="Sent as the user turn of every run, on every provider."
          error={errors.instructions}
        >
          <Textarea
            id="cake-instructions"
            rows={8}
            value={draft.instructions}
            placeholder="Check the open pull requests and address any review comments."
            aria-invalid={errors.instructions !== undefined}
            onBlur={() => touchField("instructions")}
            onChange={(event) => {
              editField("instructions");
              patch({ instructions: event.currentTarget.value });
            }}
          />
        </FormField>
      </DialogPanel>

      <DialogFooter className="sm:justify-between">
        {mode === "edit" && isConfirmingDelete ? (
          <CakeDeleteConfirmation
            cakeName={draft.name}
            isSaving={isSaving}
            onCancel={() => setIsConfirmingDelete(false)}
            onConfirm={onDelete}
          />
        ) : mode === "edit" ? (
          <Button
            type="button"
            variant="destructive-outline"
            onClick={() => setIsConfirmingDelete(true)}
            disabled={isSaving}
          >
            Delete
          </Button>
        ) : (
          <span />
        )}
        {isConfirmingDelete ? null : (
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={onCancel} disabled={isSaving}>
              Cancel
            </Button>
            {/*
            Pressable whatever state the draft is in, because pressing it is how
            the user asks what is missing. It used to be disabled while invalid,
            which was survivable only because leaving a field accused you; now
            that an untouched field stays quiet, a disabled button would leave
            the form refusing to save and never saying why.

            Not `aria-disabled` either. That still announces "unavailable", so a
            user who takes the interface at its word never presses the one
            control that would explain the problem.

            The refusal is unchanged and now lives entirely in the handler:
            `canSubmitCakeDraft` guards the call, and a press on an invalid
            draft reveals every message at once instead of saving.
          */}
            <Button
              onClick={() => {
                setTouch(touchCakeSubmit);
                if (!canSubmitCakeDraft(draft)) return;
                onSubmit();
              }}
              disabled={isSaving}
            >
              {mode === "create" ? "Create Cake" : "Save changes"}
            </Button>
          </div>
        )}
      </DialogFooter>
    </>
  );
}
