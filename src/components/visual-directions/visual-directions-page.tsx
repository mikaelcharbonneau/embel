"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { logoUuidSchema } from "@/domain/logo-vector";
import { logoBoardGenerationIntentSchema, type IdentityAvailability, type IdentityBatchState } from "@/domain/identity-jobs";
import { getIdentityFreshness, type IdentitySystemVersion } from "@/domain/project-identity";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { useProjectIdentity } from "@/components/identity/use-project-identity";
import { IdentitySystemBoard } from "@/components/identity/identity-system-board";
import { identityBatchUnresolved } from "@/components/identity/identity-generation-controller";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { useLogoCandidate } from "@/components/logo-creation/use-logo-candidate";
import { logoCandidateKey } from "@/components/logo-creation/candidate-review";
import { LogoVerifiedPreview } from "@/components/logo-creation/verified-preview";
import { LogoDownloadControls } from "@/components/logo-creation/logo-download-controls";
import { displayLogoCost } from "@/components/logo-creation/presentation";
import { describeVisualDirections } from "./direction-presentation";
import { hasCurrentBrandAssets } from "./selected-assets";
import stage from "@/styles/branding-stage.module.css";
import { VisualDirectionsView, type VisualDirectionCard, type VisualDirectionGeneration } from "./visual-directions-view";

export function VisualDirectionsPage({ projectId }: { projectId: string }) {
  const { session } = useAccountSession();
  if (!logoUuidSchema.safeParse(projectId).success) return <section className={stage.frame}><h1 className={stage.title}>Project not found</h1><Link className={stage.actionLink} href="/brands">Back to projects</Link></section>;
  return <><AccountStatus />{session.status === "ready" && <OwnedVisualDirections key={`${session.userId}:${session.generation}:${projectId}`} account={session} projectId={projectId} />}</>;
}

function availabilityReason(availability: IdentityAvailability | undefined) {
  if (!availability) return "Checking your saved logo and generation availability…";
  if (availability.status === "available") return availability.version === 3 ? null : "Visual direction generation is being updated. Check again shortly.";
  switch (availability.reason) {
    case "logo_selection_required": return "Choose a logo concept first.";
    case "logo_needs_review": return "Your logo uses earlier inputs. Review your concept choice before generating directions.";
    case "inputs_not_ready": return "Finish your saved brief and brand name before generating directions.";
    case "unsupported_brand_text": return "Some characters in your name cannot yet be rendered in downloadable brand assets. Update the name in your logo brief before generating directions.";
    case "reference_limit_exceeded": return "Use up to three inspiration images alongside your chosen logo.";
    case "reference_bytes_exceeded": return "Your chosen logo and inspiration images are too large together. Remove a reference image and try again.";
    case "references_unavailable": return "An inspiration image could not be verified. Check your saved references.";
    default: return "Generation is temporarily unavailable. Your saved work is kept.";
  }
}
function progressStatus(batch: IdentityBatchState | null): VisualDirectionGeneration["status"] {
  if (!batch) return "idle";
  return batch.status === "succeeded" ? "complete" : batch.status === "needs_reconciliation" ? "uncertain"
    : batch.status === "cancel_requested" ? "stopping" : batch.status;
}

function OwnedVisualDirections({ account, projectId }: { account: VerifiedAccount; projectId: string }) {
  const { isCurrent } = useAccountSession(), memory = useLogoDraftMemory();
  const logo = useLogoWorkspace({ projectId, memory });
  const identity = useProjectIdentity(projectId, undefined, { logoDirections: true });
  const { client, generation } = identity;
  const ownedLogo = isCurrent(account) && logo.workspace?.ownerId === account.userId && logo.workspace.projectId === projectId;
  const source = ownedLogo ? logo.stagePayloads?.concepts?.payload.selected ?? null : null;
  const candidate = useLogoCandidate(ownedLogo ? logo.client : null, account, projectId, source);
  const [history, setHistory] = useState<{ client: typeof client; batch: IdentityBatchState | null; busy: boolean; error: string | null } | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { historyRequest.current?.abort(); historyRequest.current = null; }, [client]);
  const shownHistory = history?.client === client ? history : null;
  const batch = shownHistory?.batch ?? generation.batch ?? generation.overview?.latest ?? null;
  const availability = generation.overview?.availability;
  const currentBatch = Boolean(batch?.sourceLogo && batch.sourceLogoCurrent && source
    && logoCandidateKey(batch.sourceLogo.source) === logoCandidateKey(source));
  const selection = identity.checked && !identity.selectionUncertain ? identity.overview?.currentSelection : null;
  const selectedSystem = selection?.system;
  const logoPending = !ownedLogo || !logo.client || logo.pending || logo.dirty || Boolean(logo.draft?.conflict);
  const blockedReason = availabilityReason(availability) ?? (logoPending ? "Wait for your logo changes to save before continuing." : identity.generationBlockedReason);
  const unresolved = Boolean(generation.retained || identityBatchUnresolved(generation.batch) || identityBatchUnresolved(generation.overview?.latest ?? null));

  async function refresh() {
    await Promise.allSettled([identity.refresh(), logo.reload(false), generation.controller?.refresh()]);
    if (shownHistory?.batch) await viewBatch(shownHistory.batch.batchId);
  }
  async function viewBatch(batchId: string) {
    if (!client?.current() || historyRequest.current) return;
    const controller = new AbortController(); historyRequest.current = controller;
    setHistory({ client, batch: shownHistory?.batch ?? null, busy: true, error: null });
    try {
      const result = await client.batch(batchId, controller.signal);
      if (!controller.signal.aborted && client.current()) setHistory({ client, batch: result ?? shownHistory?.batch ?? null, busy: false,
        error: result ? null : "This saved set could not be loaded. Please try again." });
    } catch {
      if (!controller.signal.aborted && client.current()) setHistory({ client, batch: shownHistory?.batch ?? null, busy: false, error: "This saved set could not be loaded. Please try again." });
    } finally { if (historyRequest.current === controller) historyRequest.current = null; }
  }
  function start() {
    if (!client?.current() || blockedReason || unresolved || availability?.status !== "available" || availability.version !== 3) return;
    const input = logoBoardGenerationIntentSchema.parse({ version: 3, spendControl: "uncapped",
      expectedProjectRevision: availability.expectedProjectRevision, expectedReferenceRevision: availability.expectedReferenceRevision,
      expectedPreferencesRevision: availability.expectedPreferencesRevision, expectedIdentityRevision: availability.expectedIdentityRevision,
      expectedLogoRevision: availability.expectedLogoRevision, sourceLogo: availability.sourceLogo.source,
      idempotencyKey: crypto.randomUUID(), acceptedPolicyIdentity: availability.policyIdentity });
    historyRequest.current?.abort(); historyRequest.current = null; setHistory(null);
    void generation.controller?.start(input);
  }
  // Creative direction starts once on arrival with a newly chosen logo: the
  // Continue click on the logo step is the deliberate request. One marker per
  // project and logo keeps a reload or a return visit from starting another set.
  const latest = generation.overview?.latest ?? null;
  const logoKey = availability?.status === "available" && availability.version === 3 ? logoCandidateKey(availability.sourceLogo.source) : null;
  const latestForLogo = Boolean(logoKey && latest?.sourceLogo && logoCandidateKey(latest.sourceLogo.source) === logoKey);
  const autoStart = useEffectEvent(() => {
    if (!logoKey || latestForLogo || shownHistory || unresolved || blockedReason || generation.busy || !generation.overview || !identity.checked) return;
    const marker = `embel.auto-directions.v1:${projectId}:${logoKey}`;
    try { if (window.sessionStorage.getItem(marker)) return; window.sessionStorage.setItem(marker, "1"); } catch { return; }
    start();
  });
  // The start itself clears a viewed earlier set; that is the intended reaction.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { autoStart(); }, [logoKey, latestForLogo, unresolved, blockedReason, generation.busy, generation.overview, identity.checked]);
  async function choose(system: IdentitySystemVersion) {
    if (!client?.current() || choosing || identity.blocked || logoPending || !currentBatch || !identity.overview
      || getIdentityFreshness(system.input.basis, identity.overview.currentBasis).status !== "current") return;
    setChoosing(system.id);
    try { await identity.chooseSystem(false, system); if (client.current()) await generation.controller?.refresh(); }
    finally { if (client.current()) setChoosing(null); }
  }
  if (!isCurrent(account) || !identity.verified || identity.verified.userId !== account.userId) return null;
  const descriptions = describeVisualDirections(batch?.systems ?? []);
  const cards = [0, 1, 2].map(index => {
    const system = batch?.systems[index];
    const description = descriptions[index];
    if (!system || !description || !client) return null;
    // Missing or still-loading observations block choosing; they do not prove
    // that saved boards are stale or require another generation.
    const stale = !logoPending && !currentBatch || Boolean(identity.overview
      && getIdentityFreshness(system.input.basis, identity.overview.currentBasis).status !== "current");
    return { ...description,
      preview: <IdentitySystemBoard board={system.board} name={system.input.basis.name} client={client} />,
      selected: selectedSystem?.id === system.id, stale, pending: choosing === system.id,
      disabledReason: stale ? "This board uses earlier inputs. Generate a new set with your current logo." : logoPending ? "Wait for your logo changes to save."
        : choosing ? "Saving your choice…" : identity.selectionBlockedReason ?? undefined,
      onChoose: () => void choose(system) };
  }) as [VisualDirectionCard | null, VisualDirectionCard | null, VisualDirectionCard | null];
  const earlierSets = [...new Set((identity.items ?? []).flatMap(item => item.source.kind === "generated" ? [item.source.batchId] : []))];
  const selectedBatchId = selectedSystem?.source.kind === "generated" ? selectedSystem.source.batchId : null;
  const requestBatch = generation.batch ?? generation.overview?.latest ?? batch;
  const visibleStatus = generation.retained ? "uncertain" : progressStatus(requestBatch);
  const brandName = logo.stagePayloads?.brief_references?.payload.name
    ?? (identity.overview?.currentBasis.status === "available" ? identity.overview.currentBasis.basis.name : "Your brand");
  const showAssets = !choosing && !identity.pending && !logoPending && !identity.strategyDirty && !identity.preferencesDirty &&
    !identity.referencesPending && hasCurrentBrandAssets(selection, source);
  const chosenTitle = descriptions.find(description => description.id === selectedSystem?.id)?.title;
  return <VisualDirectionsView brandName={brandName}
    backHref={`/brands/account/${projectId}/logo`}
    logoPreview={candidate.item && logo.client ? <LogoVerifiedPreview client={logo.client} receipt={candidate.item.preview} alt="Chosen logo concept" />
      : <p role="status">{candidate.error || logo.error ? "Your selected logo could not be loaded." : candidate.loading ? "Loading your chosen logo…" : "Choose a logo concept to begin."}</p>}
    logoDownload={candidate.item && logo.client ? <LogoDownloadControls client={logo.client} account={account} projectId={projectId} original={candidate.item.preview} disabled={logoPending} compact /> : undefined}
    cards={cards} generation={{ status: visibleStatus, completed: requestBatch?.systems.length ?? 0,
      usageLabel: batch?.usage ? batch.usage.status === "recorded" ? `Recorded usage for this set: ${displayLogoCost(batch.usage.knownCostMicrousd)}`
        : `Recorded usage so far: ${displayLogoCost(batch.usage.knownCostMicrousd)}${batch.usage.status === "unknown" ? ". Some usage is still being checked." : ""}` : null,
      error: generation.error ?? identity.error ?? logo.error ?? shownHistory?.error,
      busy: Boolean(generation.busy || shownHistory?.busy), disabledReason: blockedReason,
      onGenerate: start, onCheck: () => void refresh(), onStop: unresolved && generation.stopAcknowledgedBatchId !== generation.batch?.batchId
        ? () => { if (generation.retained) void generation.controller?.closeOriginal(); else void generation.controller?.stop(); } : undefined }}
    selectionCheck={identity.selectionCheckAvailable ? { busy: identity.loading || identity.detailLoading, onCheck: () => void identity.refresh() } : undefined}
    selectionStatus={showAssets ? (chosenTitle ? `Selected direction: ${chosenTitle}.` : "Your saved direction is selected in another set.") : null}
    selectionError={identity.selectionUncertain ? "Your choice could not be confirmed. Use Check saved choice before choosing again." : null}
    finalAction={showAssets && <Link className="identity-primary-button" href={`/brands/account/${projectId}/logo/deliverables`}>Continue</Link>}
    history={<>
      {shownHistory?.batch && shownHistory.batch.batchId !== requestBatch?.batchId && <p>You are viewing an earlier saved set. The progress above is for your latest request.</p>}
      {generation.retained && generation.lookup === "not_found" && <button type="button" className="identity-secondary-button" disabled={Boolean(generation.busy)} onClick={() => void generation.controller?.retryOriginal()}>Retry original request</button>}
      {selectedBatchId && selectedBatchId !== batch?.batchId && <p>Your chosen direction is in an earlier set. <button type="button" className="text-link" disabled={Boolean(shownHistory?.busy)} onClick={() => void viewBatch(selectedBatchId)}>View chosen direction</button></p>}
      {earlierSets.length > 1 && <details><summary>Earlier sets</summary>{earlierSets.map((batchId, index) => <button key={batchId} type="button" className="identity-secondary-button" disabled={batch?.batchId === batchId || Boolean(shownHistory?.busy)} onClick={() => void viewBatch(batchId)}>Saved set {earlierSets.length - index}</button>)}
        {identity.nextCursor && <button className="text-link" type="button" disabled={identity.loadingMore} onClick={() => void identity.loadMore()}>Show older sets</button>}</details>}
    </>} />;
}
