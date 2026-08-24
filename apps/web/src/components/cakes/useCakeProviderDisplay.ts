"use client";

import { useAtomValue } from "@effect/atom-react";
import { ProviderDriverKind } from "@t3tools/contracts";

import { getProviderModels } from "~/providerModels";
import { primaryServerProvidersAtom } from "~/state/server";

import { AVAILABLE_PROVIDER_OPTIONS } from "../chat/providerIconUtils";
import { resolveEffortOptions } from "./CakeFormDialog.logic";

export interface CakeProviderDisplay {
  readonly driverKind: ProviderDriverKind;
  /** What the provider is called in the UI, e.g. the logo's accessible name. */
  readonly providerLabel: string;
  /** The model's marketing name when the server knows it, else its slug. */
  readonly modelLabel: string;
  /**
   * The effort's display name, or "" when this model has no effort ladder.
   *
   * Empty rather than the raw id: a row writes it in brackets after the model,
   * and "(  )" trailing a model name is worse than nothing at all.
   */
  readonly effortLabel: string;
}

/**
 * How a cake's provider and model should be written on a row.
 *
 * Both the shelf and the composer's picker identify a cake the same way, and
 * both have to resolve a model slug against whatever the server currently
 * advertises. Keeping that resolution here is what lets each row component stay
 * free of atoms, which is the only way they can be rendered in a test.
 */
export function useCakeProviderDisplay(cake: {
  readonly providerKind: string;
  readonly model: string;
  readonly effort: string;
}): CakeProviderDisplay {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const driverKind = ProviderDriverKind.make(cake.providerKind);
  const providerModel = getProviderModels(providers, driverKind).find(
    (candidate) => candidate.slug === cake.model,
  );
  return {
    driverKind,
    providerLabel:
      AVAILABLE_PROVIDER_OPTIONS.find((option) => option.value === cake.providerKind)?.label ??
      cake.providerKind,
    modelLabel: providerModel?.name ?? cake.model,
    // Resolved against the model, not stored: an effort id only means anything
    // in the ladder of the model it was chosen for, and the cake's model can be
    // edited after the fact.
    effortLabel:
      resolveEffortOptions(providerModel?.capabilities?.optionDescriptors).find(
        (option) => option.id === cake.effort,
      )?.label ?? "",
  };
}
