"use client";

import { useEffect, useState } from "react";
import type { LogoConceptBatch } from "@/domain/logo-jobs";
import type { LogoRasterSource } from "@/domain/logo-vector";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "../identity/account-logo-client";
import { useAccountSession, type VerifiedAccount } from "../workspace/account-session";
import { logoCandidateKey } from "./candidate-review";
import { conceptVersions, type LogoCardVersion } from "./concept-versions";
import type { LogoRefinementHistoryState } from "./refinement-history";
import { useLogoRefinementHistory } from "./use-logo-refinement-history";

/**
 * The chosen logo as the steps name it: "Concept 1" for an original concept, "Concept 1 · Version 2" for a changed
 * version of it. Null when the choice is not one of the batch's concepts or their saved versions.
 */
export function chosenLogoLabel(
  batch: LogoConceptBatch | null,
  versions: Record<string, LogoCardVersion[]>,
  selected: LogoRasterSource | null,
): string | null {
  if (!batch || !selected) return null;
  const key = logoCandidateKey(selected);
  const card = Object.entries(versions).find(([, items]) => items.some((item) => item.key === key));
  const ordinal = batch.slots.find((slot) => slot.id === card?.[0])?.ordinal;
  if (!card || ordinal === undefined) return null;
  const version = selected.kind === "refinement" ? card[1].find((item) => item.key === key)?.label : null;
  return `Concept ${ordinal + 1}${version ? ` · ${version}` : ""}`;
}

/** The chosen logo in a sentence or a folded answer: "Concept 1, version 2". */
export const chosenLogoAnswer = (label: string) => label.replace(" · ", ", ").replace("Version", "version");

/** The batch a chosen logo comes from: its own for a concept, its first concept's for a changed version. */
function sourceBatchId(source: LogoRasterSource, history: LogoRefinementHistoryState): string | null {
  const records = new Map(history.items.filter((row) => row.verified).map((row) => [row.record.id, row.record]));
  const seen = new Set<string>();
  let current = source;
  while (current.kind === "refinement" && !seen.has(current.rasterRevisionId)) {
    seen.add(current.rasterRevisionId);
    const parent = records.get(current.rasterRevisionId)?.source;
    if (!parent || parent.kind === "vector") return null;
    current = parent;
  }
  return current.kind === "concept" ? current.batchId : null;
}

/**
 * Names the chosen logo outside the Logo step (Creative direction, the finished brand), from its batch and its saved
 * versions. Reads metadata only; null while unknown.
 */
export function useChosenLogoLabel(
  client: AccountLogoClient | null,
  account: VerifiedAccount,
  projectId: string,
  selected: LogoRasterSource | null,
): string | null {
  const { isCurrent } = useAccountSession();
  const { state: history } = useLogoRefinementHistory(client, account, projectId);
  const batchId = selected ? sourceBatchId(selected, history) : null;
  const [read, setRead] = useState<{ client: AccountLogoClient; batch: LogoConceptBatch } | null>(null);
  useEffect(() => {
    if (!client || !batchId) return;
    const controller = new AbortController();
    void client
      .readLogoConceptBatch(batchId, controller.signal)
      .then((batch) => {
        if (
          batch &&
          !controller.signal.aborted &&
          isCurrent(account) &&
          isAccountLogoClientCurrent(client, account, projectId)
        )
          setRead({ client, batch });
      })
      .catch(() => {
        /* Unknown: the folded entry says "Chosen" until the Logo step names it. */
      });
    return () => controller.abort();
  }, [account, batchId, client, isCurrent, projectId]);
  const batch = read && read.client === client && read.batch.id === batchId ? read.batch : null;
  return chosenLogoLabel(batch, conceptVersions(batch, history), selected);
}
