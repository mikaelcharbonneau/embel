"use client";

import Link from "next/link";
import { useProjectLogoEvidence } from "@/components/workspace/project-workspace";
import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import type { LogoRasterSource } from "@/domain/logo-workspace";
import { logoUuidSchema } from "@/domain/logo-vector";
import type { LogoConceptBatch, LogoQuoteRequest } from "@/domain/logo-jobs";
import { brandTextReadiness } from "@/domain/brand-board-fonts";
import { IMAGE_INPUT_LIMITS } from "@/domain/logo-image-limits";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoCreation } from "./use-logo-creation";
import { useGenerationEstimate } from "./use-generation-estimate";
import { LogoGenerationAction } from "./generation-action";
import { acceptedConceptAttempt } from "./presentation";
import type { LogoCreationState } from "./creation-controller";
import { LogoVerifiedPreview } from "./verified-preview";
import { selectLogoCandidate, recoverLogoSelection, LogoSelectionConflictResolvedError } from "./selection-controller";
import { useInspirationLikes } from "@/components/workspace/inspiration-likes-signal";
import { AccountRequestError, accountErrorMessage } from "../workspace/account-api";
import { useLogoBatchHistory } from "./use-logo-batch-history";
import { useLogoRefinementHistory } from "./use-logo-refinement-history";
import { logoBatchRecoveryRequestKeys, checkLogoBatchRequests, type LogoBatchRequestCheck } from "./batch-history";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import { ConceptsComposer } from "./concepts-composer";
import { conceptVersions } from "./concept-versions";
import { LogoConceptGridView } from "./concept-grid";
import { LogoCostConfirmation } from "./cost-confirmation";
import { LogoCandidateComparison } from "./candidate-comparison";
import { logoCandidateKey } from "./candidate-review";
import { useLogoCandidate } from "./use-logo-candidate";
import { LogoDownloadControls } from "./logo-download-controls";
import { prepareSavedLogoConcepts, logoDraftHasProtectedWork } from "./saved-inputs-controller";
import { LogoSavedInputsStatus, type LogoSavedInputState } from "./saved-inputs-status";
import { LogoTypesQuestion } from "./logo-types-question";
import { EmbelIdentity } from "@/components/workspace/embel-identity";
import { journeyPartLabel } from "@/domain/journey";
import styles from "./logo-creation.module.css";
import stage from "@/styles/branding-stage.module.css";

const noSubscription = () => () => undefined;
const EMPTY_CREATION: LogoCreationState = { phase: "idle", quote: null, request: null, error: null };
const emptyCreation = () => EMPTY_CREATION;

export function LogoCreationWorkspace({ projectId, mode = "setup", onContinue, continueHidden = false }: {
  projectId: string;
  mode?: "setup" | "refine";
  /** In the project conversation, Continue opens Creative direction below instead of its page. */
  onContinue?: () => void;
  /** Hidden once Creative direction is already shown below. */
  continueHidden?: boolean;
}): React.JSX.Element {
  const { session } = useAccountSession();
  const memory = useLogoDraftMemory();
  if (session.status !== "ready") return <section className={styles.panel} aria-label="Create a logo"><h1 className={stage.title}>Create a logo</h1><AccountStatus retainedEdits={memory.hasUnsaved()} /></section>;
  if (!logoUuidSchema.safeParse(projectId).success) return <section className={styles.panel} role="alert"><h1 className={stage.title}>Project unavailable</h1><p>Open a saved project to continue.</p><Link className={stage.actionLink} href="/brands">View projects</Link></section>;
  return <OwnedLogoCreation key={session.userId + ":" + session.generation + ":" + projectId} account={session} projectId={projectId} mode={mode} onContinue={onContinue} continueHidden={continueHidden} />;
}

/** All editable brief/reference values and retained requests live in the shared memory. */
function OwnedLogoCreation({ account, projectId, onContinue, continueHidden }: {
  account: VerifiedAccount;
  projectId: string;
  mode?: "setup" | "refine";
  onContinue?: () => void;
  continueHidden?: boolean;
}): React.JSX.Element {
  const { isCurrent } = useAccountSession();
  const memory = useLogoDraftMemory();
  const { workspace, creation: generation, capabilities } = useLogoCreation(projectId);
  const generationState = useSyncExternalStore(generation?.subscribe ?? noSubscription, generation?.getSnapshot ?? emptyCreation, emptyCreation);
  const { client, draft, reload: reloadWorkspace } = workspace;
  const { controller: batchHistory, state: batchHistoryState } = useLogoBatchHistory(client, account, projectId);
  const { controller: refinementHistory, state: refinementHistoryState } = useLogoRefinementHistory(client, account, projectId);
  const savedInputsRead = useRef<AbortController | null>(null);
  const refinementInput = useRef<HTMLTextAreaElement | null>(null);
  const preparedInputsKey = useRef<string | null>(null);
  const requestRead = useRef<AbortController | null>(null);
  const [batchRead, setBatchRead] = useState<{ id: string; client: AccountLogoClient; revision: number; batch: LogoConceptBatch | null; unavailable: boolean } | null>(null);
  const [requestReadouts, setRequestReadouts] = useState<Record<string, LogoBatchRequestCheck>>({});
  const [checkingRequest, setCheckingRequest] = useState(false);
  const [batchReload, setBatchReload] = useState(0);
  const [comparison, setComparison] = useState<LogoRasterSource[]>([]);
  const [viewedVersions, setViewedVersions] = useState<Record<string, { key: string; count: number }>>({});
  const selectedRefinementRequests = useRef(new Set<string>());
  const refreshedRefinementRequests = useRef(new Set<string>());
  const conceptFilter = "all" as const;
  const [refineInstruction, setRefineInstruction] = useState("");
  const [selectionState, setSelectionState] = useState<{ selected: LogoRasterSource | null; workspaceRevision: number | null; busy: boolean; error: string | null }>({ selected: null, workspaceRevision: null, busy: false, error: null });
  const selecting = useRef(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [saveReadout, setSaveReadout] = useState<{ key: string; message: string } | null>(null);
  const [savedInputs, setSavedInputs] = useState<LogoSavedInputState>({ status: "idle" });
  const savedInputsBusy = savedInputs.status === "reading" || savedInputs.status === "saving";
  const saved = workspace.workspace;
  useProjectLogoEvidence(saved ? { ownerId: saved.ownerId, projectId: saved.projectId, projectRevision: saved.heads.projectRevision,
    approved: Boolean(workspace.status === "ready" && !workspace.error && !workspace.pending && !workspace.dirty && !draft?.conflict && saved.approvedLogo
      && !saved.staleStages.some(({ stage }) => stage !== "directions" && stage !== "deliverables")),
    needsReview: saved.staleStages.some(({ stage }) => stage !== "directions" && stage !== "deliverables") } : null);
  const needsInitialization = Boolean(saved && !saved.stages.brief_references);
  const workspaceRevision = saved?.heads.workspaceRevision;
  const dispatch = generationState.request && generationState.request.status !== "not_found" && generationState.request.receipt && "jobIds" in generationState.request.receipt ? generationState.request.receipt : null;
  const batchIds = [...new Set([...(dispatch?.batchId ? [dispatch.batchId] : []), ...batchHistoryState.items.map(batch => batch.id),
    ...(workspace.stagePayloads?.concepts?.payload.batchIds ?? []).slice().reverse()])];
  const batchId = batchIds[0];
  const matchingBatchRead = client && saved?.ownerId === account.userId && saved.projectId === projectId
    && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId) && batchRead?.client === client && batchRead.id === batchId ? batchRead : null;
  // Successful immutable previews do not become different bytes when a selection
  // advances workspace heads. Keep display separate from fresh action eligibility.
  const activeBatch = matchingBatchRead?.batch ?? null;
  const batchReady = !!matchingBatchRead && matchingBatchRead.revision === workspaceRevision && !matchingBatchRead.unavailable;
  const savedBatchUnavailable = Boolean(matchingBatchRead?.unavailable || !activeBatch && (workspace.error || batchHistoryState.error));
  const savedBatchLoading = Boolean(!activeBatch && !savedBatchUnavailable && (workspace.status !== "ready" || !saved || !client
    || !batchHistoryState.loaded || saved.stages.concepts && !workspace.stagePayloads?.concepts || batchId));
  // Presentation only: an incomplete first read is not proof of no selection.
  // Retained payloads and history keep ordinary same-owner refreshes resolved.
  const initialConceptReadState: "loading" | "unavailable" | undefined =
    !saved || saved.stages.concepts && !workspace.stagePayloads?.concepts || !activeBatch && (!batchHistoryState.loaded || batchId)
    ? savedBatchUnavailable ? "unavailable" : "loading" : undefined;
  const initialConceptReadMessage = initialConceptReadState === "unavailable" ? "Saved logo details unavailable." : "Loading saved logo details…";
  const pendingIntentKey = workspace.pendingIntent?.requestKey;
  const recoveryKeys = [...new Set([...(pendingIntentKey ? [pendingIntentKey] : []), ...logoBatchRecoveryRequestKeys(activeBatch)])];
  const activeRequest = generationState.request ?? recoveryKeys.map(key => requestReadouts[key]?.state).find(state => state !== null && state !== undefined) ?? null;

  useEffect(() => () => { savedInputsRead.current?.abort(); requestRead.current?.abort(); }, []);

  useEffect(() => { if (dispatch?.batchId) void batchHistory?.refresh(); }, [batchHistory, dispatch?.batchId]);

  const refinementRequestKey = activeRequest && activeRequest.status !== "not_found" && activeRequest.receipt && "operation" in activeRequest.receipt && activeRequest.receipt.operation === "identity.logo_refine" ? activeRequest.requestKey : null;
  const refinementRequestStatus = activeRequest?.status;
  useEffect(() => {
    if (!refinementHistory || !refinementRequestKey) return;
    void refinementHistory.refresh();
    if (!["admitted", "running"].includes(refinementRequestStatus ?? "")) return;
    const timer = setInterval(() => { void refinementHistory.refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [refinementHistory, refinementRequestKey, refinementRequestStatus]);

  const refinementRevisionId = saved?.stages.refinements?.id;
  useEffect(() => { if (refinementRevisionId) void refinementHistory?.refresh(); }, [refinementHistory, refinementRevisionId]);

  useEffect(() => {
    if (!client || !batchId || workspaceRevision === undefined) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId)
      && memory.get(projectId)?.workspace?.heads.workspaceRevision === workspaceRevision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const batch = await client!.readLogoConceptBatch(batchId!, controller.signal);
        if (!current()) return;
        setBatchRead(previous => batch ? { id: batchId!, client: client!, revision: workspaceRevision!, batch, unavailable: false }
          : previous && previous.client === client && previous.id === batchId ? { ...previous, unavailable: true } : { id: batchId!, client: client!, revision: workspaceRevision!, batch: null, unavailable: true });
        if (batch?.slots.some(slot => ["queued", "running"].includes(slot.attempts.at(-1)?.state ?? ""))) timer = setTimeout(() => void read(), 3000);
        else if (generation?.getSnapshot().phase === "active") {
          await generation.checkRequest();
          const retained = memory.get(projectId);
          if (current() && retained && !retained.pendingIntent && !retained.dirty) void reloadWorkspace(false);
        }
      } catch {
        if (current()) setBatchRead(previous => previous && previous.client === client && previous.id === batchId ? { ...previous, unavailable: true } : { id: batchId!, client: client!, revision: workspaceRevision!, batch: null, unavailable: true });
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [account, batchId, batchReload, client, dispatch?.requestKey, generation, isCurrent, memory, projectId, reloadWorkspace, workspaceRevision]);

  const quoteReviewBlocked = ["rejected", "refreshing_workspace", "resolve_draft"].includes(generationState.phase);
  const editing = workspace.canEdit && !savedInputsBusy && !selectionState.busy;
  const pendingSave = draft?.pendingMutation?.command;
  const pendingSelection = pendingSave?.method === "selectLogoConcept" || pendingSave?.method === "selectLogoRaster" ? pendingSave : null;
  const selectedLogo = selectionState.workspaceRevision === saved?.heads.workspaceRevision
    ? selectionState.selected : workspace.stagePayloads?.concepts?.payload.selected ?? null;
  const focusedReview = useLogoCandidate(client, account, projectId, selectedLogo);
  const focusedReceipt = focusedReview.item?.preview ?? null;
  const cardVersions = conceptVersions(activeBatch, refinementHistoryState);
  const selectedCard = Object.entries(cardVersions).find(([, versions]) => selectedLogo && versions.some(version => version.key === logoCandidateKey(selectedLogo)));
  const selectedOrdinal = activeBatch?.slots.find(slot => slot.id === selectedCard?.[0])?.ordinal;
  const selectedLabel = selectedLogo ? selectedOrdinal !== undefined ? `Concept ${selectedOrdinal + 1}${selectedLogo.kind === "refinement" ? ` · ${selectedCard?.[1].find(version => version.key === logoCandidateKey(selectedLogo))?.label ?? "Refined"}` : ""}` : "Your chosen logo" : undefined;
  const refinementBusy = Boolean(refinementRequestKey && ["admitted", "running", "needs_reconciliation"].includes(refinementRequestStatus ?? ""));
  const completedRefinement = refinementHistoryState.items.find(({ record, verified }) => verified && record.requestKey === refinementRequestKey && record.state === "succeeded" && record.billing.status === "recorded" && record.preview?.publicationState === "committed")?.record;
  const composerStatus = selectionState.busy ? "Saving your choice…" : refinementBusy ? refinementRequestStatus === "needs_reconciliation" ? "Checking on your last change…" : "Refining your logo…"
    : completedRefinement ? "Your refined logo is ready on its card." : initialConceptReadState ? initialConceptReadMessage : !selectedLogo ? "Select a logo above to get started." : focusedReview.loading ? "Loading your chosen logo…" : focusedReview.error ? "Your chosen logo could not be loaded. Try choosing it again."
    : !capabilities.isAvailable("identity.logo_refine") ? "Changing logos is unavailable right now. Your message is kept." : "";

  const canDiscard = Boolean(editing && (workspace.dirty || draft?.conflict) && !workspace.pending && !checkingRequest);
  const snapshot = workspace.referenceSnapshot;
  const referenceCount = draft?.references.length ?? snapshot?.references.length ?? 0;
  const conceptReferenceLimitExceeded = referenceCount > IMAGE_INPUT_LIMITS.images;
  const autoSave = !needsInitialization;

  const nameReadiness = brandTextReadiness(draft?.brief.name ?? "");
  const canPrepareInputs = Boolean(saved && editing && !workspace.pending && !workspace.dirty && !draft?.conflict && !quoteReviewBlocked);
  const canEstimate = nameReadiness.supported && canPrepareInputs;
  const brief = workspace.stagePayloads?.brief_references;
  const conceptsRequest: LogoQuoteRequest | null = !activeBatch && !batchId && !savedBatchLoading && !savedBatchUnavailable && canEstimate && !conceptReferenceLimitExceeded && capabilities.isAvailable("identity.logo_concept")
    ? savedInputs.status === "prepared" && JSON.stringify(savedInputs.request.expected) === JSON.stringify(saved?.heads) ? savedInputs.request : null : null;
  const conceptEstimate = useGenerationEstimate(generation, conceptsRequest);
  const moreEstimate = useGenerationEstimate(generation, canEstimate && batchReady && saved && brief && !conceptReferenceLimitExceeded && capabilities.isAvailable("identity.logo_concept")
    ? { operation: "more_concepts", expected: saved.heads, briefRevisionId: brief.id, referenceSnapshotId: brief.payload.referenceSnapshotId } : null);
  const failedSlotIds = activeBatch?.slots.filter(slot => !acceptedConceptAttempt(slot) && slot.attempts.at(-1)?.state === "failed" && slot.attempts.at(-1)?.billing.status === "recorded").map(slot => slot.id) ?? [];
  const retryEstimate = useGenerationEstimate(generation, canEstimate && batchReady && saved && activeBatch && failedSlotIds.length && capabilities.isAvailable("identity.logo_concept")
    ? { operation: "retry_failed", expected: saved.heads, sourceBatchId: activeBatch.id, failedSlotIds } : null);
  const refinementEstimate = useGenerationEstimate(generation, canEstimate && saved && selectedLogo && focusedReceipt && !refinementBusy && refineInstruction.trim() && capabilities.isAvailable("identity.logo_refine")
    ? { operation: "refine_preview", expected: saved.heads, source: selectedLogo, instruction: refineInstruction.trim() } : null);
  const prepareLatestInputs = useEffectEvent(() => { void prepareSavedInputs(); });
  // Likes changed in Inspiration on this page: before the first concepts, update
  // the brief and liked images (re-reading the workspace, whose reference
  // revision may have moved). Once concepts exist the brief is left as it is,
  // because changing it would send the chosen logo back for review.
  const likes = useInspirationLikes(account.userId, projectId);
  const seenLikes = useRef(likes);
  const refreshForLikes = useEffectEvent(() => { void prepareSavedInputs(true); });
  useEffect(() => {
    if (likes === null || likes === seenLikes.current) return;
    if (seenLikes.current === null) { seenLikes.current = likes; return; }
    if (batchId || savedBatchLoading || generationState.phase !== "idle" || savedInputsBusy || !["idle", "prepared", "blocked"].includes(savedInputs.status)) return;
    seenLikes.current = likes;
    const timer = setTimeout(refreshForLikes, 0);
    return () => clearTimeout(timer);
  }, [likes, batchId, savedBatchLoading, generationState.phase, savedInputsBusy, savedInputs.status]);
  const preparationKey = saved ? JSON.stringify(saved.heads) : null;
  useEffect(() => {
    if (!generation || !preparationKey || !canPrepareInputs || batchId || savedBatchLoading || savedBatchUnavailable
      || generationState.phase !== "idle" || !["idle", "prepared"].includes(savedInputs.status) || preparedInputsKey.current === preparationKey) return;
    const timer = setTimeout(() => { preparedInputsKey.current = preparationKey; prepareLatestInputs(); }, 0);
    return () => clearTimeout(timer);
  }, [generation, preparationKey, canPrepareInputs, batchId, savedBatchLoading, savedBatchUnavailable, generationState.phase, savedInputs.status]);

  // Once concepts exist, the brief stays as it is; compare it with the saved
  // likes (read-only) and offer to use newer likes for the next concepts.
  const [likesCheck, setLikesCheck] = useState<{ key: string; outdated: boolean } | null>(null);
  const likesCheckKey = batchId && saved ? `${likes ?? ""}|${JSON.stringify(saved.heads)}` : null;
  const checkLikes = useEffectEvent(async (key: string) => {
    if (!client || !isCurrent(account) || savedInputsRead.current) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    const result = await prepareSavedLogoConcepts({ ownerId: account.userId, projectId, signal: controller.signal, checkOnly: true,
      isCurrent: current, getDraft: () => memory.get(projectId), readSavedInputs: signal => client.readLogoSavedInputs(signal),
      saveBrief: async () => {}, saveReferences: async () => {}, readBriefRevision: (id, signal) => client.getLogoStageRevision("brief_references", id, signal),
      onProgress: () => {} });
    if (current()) setLikesCheck({ key, outdated: result.status === "checked" && result.outdated });
  });
  useEffect(() => {
    if (!likesCheckKey || likesCheck?.key === likesCheckKey || generationState.phase !== "idle" || savedInputsBusy) return;
    const timer = setTimeout(() => { void checkLikes(likesCheckKey); }, 0);
    return () => clearTimeout(timer);
  }, [likesCheckKey, likesCheck?.key, generationState.phase, savedInputsBusy]);
  const newerLikes = Boolean(likesCheckKey && likesCheck?.key === likesCheckKey && likesCheck.outdated);

  async function prepareSavedInputs(refreshWorkspace = false) {
    if (!client || !generation || !isCurrent(account) || savedInputsRead.current || selecting.current
      || generation.getSnapshot().phase !== "idle") return;
    const controller = new AbortController(); savedInputsRead.current = controller;
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    try {
      if (refreshWorkspace) {
        setSavedInputs({ status: "reading" });
        const [, result] = await Promise.all([capabilities.refresh(), workspace.reload(false)]);
        if (!current()) return;
        if (result !== "reloaded") {
          setSavedInputs({ status: "blocked", message: result === "draft_blocked"
            ? "Save or undo your logo brief changes first. Your changes are kept."
            : "Your saved logo details could not be loaded. Try again." });
          return;
        }
      }
      const result = await prepareSavedLogoConcepts({ ownerId: account.userId, projectId, signal: controller.signal,
        isCurrent: current, getDraft: () => memory.get(projectId), readSavedInputs: signal => client.readLogoSavedInputs(signal),
        saveBrief: brief => workspace.saveBrief(brief), saveReferences: selections => workspace.saveReferences(selections), readBriefRevision: (id, signal) => client.getLogoStageRevision("brief_references", id, signal),
        onProgress: status => { if (current()) setSavedInputs({ status }); },
      });
      if (current() && result.status !== "obsolete") {
        if (result.status === "prepared") preparedInputsKey.current = JSON.stringify(result.request.expected);
        setSavedInputs(result);
      }
    } finally { if (savedInputsRead.current === controller) savedInputsRead.current = null; }
  }

  async function checkRequest() {
    if (!client || requestRead.current || !recoveryKeys.length) return;
    const controller = new AbortController(); requestRead.current = controller; setCheckingRequest(true);
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    try {
      const pendingKey = workspace.pendingIntent?.requestKey;
      if (pendingKey && generation) await generation.checkRequest();
      if (!current()) return;
      const checks = await checkLogoBatchRequests({ client, requestKeys: recoveryKeys.filter(key => !(generation && key === pendingKey)), isCurrent: current, signal: controller.signal });
      if (!current()) return;
      setRequestReadouts(previous => {
        const next = { ...previous };
        for (const check of checks) {
          const retained = previous[check.requestKey]?.state;
          next[check.requestKey] = { ...check, state: (!check.state || check.state.status === "not_found") && retained && retained.status !== "not_found" ? retained : check.state };
        }
        return next;
      });
      setBatchReload(value => value + 1);
      void refinementHistory?.refresh();
      const retained = memory.get(projectId);
      if (retained && !retained.pendingIntent && !retained.dirty) void reloadWorkspace(false);
    } finally {
      if (requestRead.current === controller) { requestRead.current = null; if (current()) setCheckingRequest(false); }
    }
  }

  async function checkOriginalSave() {
    if (!pendingSave || !client || requestRead.current) return;
    const key = pendingSave.body.requestKey, controller = new AbortController();
    requestRead.current = controller; setCheckingRequest(true);
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId)
      && memory.get(projectId)?.pendingMutation?.requestKey === key;
    try {
      const state = await workspace.checkPendingSave();
      if (controller.signal.aborted || !isCurrent(account) || !isAccountLogoClientCurrent(client, account, projectId)) return;
      const status = state?.status;
      if (state?.status === "succeeded" && !memory.get(projectId)?.pendingMutation) {
        setSaveReadout(null);
        if (!memory.get(projectId)?.dirty) void reloadWorkspace(false);
        return;
      }
      const message = status === "succeeded" ? "A result is recorded for the original save. Your local edits and original request stay here until its saved details can be loaded."
        : status === "not_found" ? "No result is recorded for the original save. No new save was started."
        : status === "failed" || status === "cancelled" ? "The original save did not complete. Your local edits and original request are kept."
        : status === "admitted" || status === "running" || status === "partial" ? "The original save is still being processed. Your local edits are kept."
        : "The save outcome is still uncertain. Your local edits and original request are kept.";
      setSaveReadout({ key, message });
    } catch {
      if (current()) setSaveReadout({ key, message: "The original save could not be checked. Your local edits and original request are kept." });
    } finally {
      if (requestRead.current === controller) { requestRead.current = null; if (!controller.signal.aborted) setCheckingRequest(false); }
    }
  }

  const selectCandidate = useCallback(async (source?: LogoRasterSource, retry = false) => {
    if (!client || !isCurrent(account) || selecting.current) return;
    selecting.current = true; const controller = new AbortController(); requestRead.current = controller;
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    setSelectionState(previous => ({ ...previous, busy: true, error: null }));
    try {
      const input = { client, memory, projectId, isCurrent: current, createRequestKey: () => crypto.randomUUID(), signal: controller.signal };
      const receipt = source ? await selectLogoCandidate(input, source) : await recoverLogoSelection(input, retry);
      if (current() && receipt?.revision.stage === "concepts") {
        setSelectionState({ selected: receipt.revision.payload.selected, workspaceRevision: receipt.workspace.heads.workspaceRevision, busy: false, error: null });
        if (!memory.get(projectId)?.dirty) void reloadWorkspace(false);
      }
    } catch (error) {
      if (current() && error instanceof LogoSelectionConflictResolvedError) {
        const result = await reloadWorkspace(false);
        if (current()) setSelectionState(previous => ({ ...previous, error: result === "reloaded"
          ? "Your logo changed before this choice was saved. Choose your logo again."
          : "Your choice was not saved. Your logos and edits are kept. Refresh your saved brand, then choose your logo again." }));
      } else if (current()) setSelectionState(previous => ({ ...previous, error: error instanceof AccountRequestError && error.status === 409
        ? "Your logo changed elsewhere. Check your choice before choosing again."
        : accountErrorMessage(error) + " Your choice is kept so you can try again." }));
    }
    finally { selecting.current = false; if (requestRead.current === controller) requestRead.current = null; if (current()) setSelectionState(previous => ({ ...previous, busy: false })); }
  }, [client, projectId, account, isCurrent, memory, reloadWorkspace]);

  useEffect(() => {
    if (!completedRefinement || !selectedLogo || completedRefinement.source.kind === "vector" || generationState.phase !== "idle"
      || !editing || workspace.pending || workspace.dirty || !saved || selectedRefinementRequests.current.has(completedRefinement.requestKey)
      || logoCandidateKey(completedRefinement.source) !== logoCandidateKey(selectedLogo)) return;
    const originalSource = completedRefinement.source;
    const concepts = workspace.stagePayloads?.concepts, refinements = workspace.stagePayloads?.refinements;
    const acknowledged = refinements?.id === saved.stages.refinements?.id && refinements?.payload.rasterRevisionIds.includes(completedRefinement.id)
      && concepts?.id === saved.stages.concepts?.id;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !isCurrent(account) || !draft || memory.get(projectId) !== draft || logoDraftHasProtectedWork(draft)) return;
      // Completion can be observed before the workspace reload. Wait for the
      // committed refinement stage and its matching selection baseline before
      // creating a command. A failed refresh leaves the saved result available
      // for explicit refresh/selection, without an automatic polling loop.
      if (!acknowledged) {
        if (!refreshedRefinementRequests.current.has(completedRefinement.requestKey)) {
          refreshedRefinementRequests.current.add(completedRefinement.requestKey);
          void reloadWorkspace(false);
        }
        return;
      }
      if (!concepts?.payload.selected || logoCandidateKey(concepts.payload.selected) !== logoCandidateKey(originalSource)) return;
      selectedRefinementRequests.current.add(completedRefinement.requestKey);
      void selectCandidate({ kind: "refinement", rasterRevisionId: completedRefinement.id });
    });
    return () => { cancelled = true; };
  }, [completedRefinement, projectId, selectedLogo, generationState.phase, editing, workspace.pending, workspace.dirty, workspace.stagePayloads, saved, draft, isCurrent, account, memory, reloadWorkspace, selectCandidate]);

  function discardAndReload() {
    if (!canDiscard || requestRead.current) return;
    const latest = memory.get(projectId);
    if (!latest || latest.pendingMutation || latest.pendingIntent || latest.pendingExport) return;
    setConfirmReload(false);
    void workspace.reload(true);
  }

  function compareCandidate(source: LogoRasterSource) {
    const removing = comparison.some(item => logoCandidateKey(item) === logoCandidateKey(source));
    setComparison(previous => previous.some(item => logoCandidateKey(item) === logoCandidateKey(source))
      ? previous.filter(item => logoCandidateKey(item) !== logoCandidateKey(source))
      : previous.length < 2 ? [...previous, source] : previous);
    if (!removing) requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-logo-comparison]")?.focus());
  }

  // Saves that need checking, retrying or discarding stay in reach wherever the step is shown.
  const recoveryTools = <>
    {pendingSelection && <div className={styles.actions}><p className={styles.note}>We couldn’t confirm that your logo choice was saved. Your logos are safe.</p><button className={styles.secondaryButton} type="button" disabled={selectionState.busy} onClick={() => void selectCandidate()}>Check my choice</button><button className={styles.secondaryButton} type="button" disabled={selectionState.busy || draft?.conflict} onClick={() => void selectCandidate(undefined, true)}>Save my choice again</button></div>}
    {workspace.status === "error" && !workspace.pending && <button className={styles.secondaryButton} type="button" onClick={() => void workspace.reload(false)}>Try loading again</button>}
    {(pendingSave?.method === "saveLogoBrief" || pendingSave?.method === "saveLogoReferences") && <div className={styles.actions}>
      <p className={styles.note}>A previous save is awaiting confirmation. This action checks it first and retries the original save only if no result is recorded.</p>
      <button className={styles.secondaryButton} type="button" disabled={!editing || checkingRequest} onClick={() => void checkOriginalSave()}>Check original save</button>
      {draft?.conflict && <p className={styles.note}>Check reads the original save without sending a new one. Conflicting edits and unresolved requests cannot be discarded here.</p>}
      <button className={styles.secondaryButton} type="button" disabled={!editing || draft?.conflict || checkingRequest} onClick={() => {
        if (pendingSave.method === "saveLogoBrief") void workspace.saveBrief(pendingSave.body.brief);
        else void workspace.saveReferences(pendingSave.body.selections);
      }}>Check and retry original save</button>
      {saveReadout && saveReadout.key === pendingSave.body.requestKey && <p className={styles.note} role="status">{saveReadout.message}</p>}
    </div>}
    {canDiscard && <div className={styles.actions}>
      <button className={styles.secondaryButton} type="button" onClick={() => setConfirmReload(true)}>Discard local edits and reload</button>
      {confirmReload && <div role="group" aria-label="Confirm discarding local edits">
        <p className={styles.warning}>Replace the brief and reference changes in this tab with the latest saved version?</p>
        <button className={styles.secondaryButton} type="button" onClick={() => setConfirmReload(false)}>Keep editing</button>
        <button className={styles.secondaryButton} type="button" onClick={discardAndReload}>Discard edits and load saved version</button>
      </div>}
    </div>}
  </>;

  // Continue sits at the end of the step, below the refine box.
  // Continue is the deliberate request for creative directions: the next step starts one set.
  const markDirectionsIntent = () => { try { window.sessionStorage.setItem(`embel.directions-intent.v1:${projectId}`, String(Date.now())); } catch { /* Then directions wait for a click. */ } };
  const continueAction = activeBatch && !continueHidden ? workspace.stagePayloads?.concepts?.payload.selected && !selectionState.busy
    ? onContinue ? <button className={styles.primaryButton} type="button" onClick={() => { markDirectionsIntent(); onContinue(); }}>Continue</button>
      : <Link className={`${styles.primaryButton} ${stage.actionLink}`} href={`/brands/account/${projectId}/logo/directions`} onClick={markDirectionsIntent}>Continue</Link>
    : <button className={styles.primaryButton} type="button" disabled title={initialConceptReadState ? initialConceptReadMessage : "Select a logo and wait for it to save"}>Continue</button> : null;
  const conceptsComposer = <ConceptsComposer inputRef={refinementInput} projectId={projectId} selectionReadState={initialConceptReadState} selectedLabel={selectedLabel} selectedPreview={focusedReceipt && client ? <LogoVerifiedPreview client={client} receipt={focusedReceipt} alt="Selected logo" /> : undefined}
    selectedActions={client && focusedReceipt ? <LogoDownloadControls client={client} account={account} projectId={projectId} original={focusedReceipt} disabled={selectionState.busy} compact /> : undefined}
    idle={!activeBatch && !batchId && !initialConceptReadState} footer={continueAction} status={composerStatus} onShowResult={completedRefinement ? () => { const slotId = Object.entries(cardVersions).find(([, versions]) => versions.some(version => version.source.kind === "refinement" && version.source.rasterRevisionId === completedRefinement.id))?.[0]; if (slotId) document.querySelector<HTMLElement>(`[data-concept-slot="${slotId}"]`)?.scrollIntoView({ block: "center" }); } : undefined} instruction={refineInstruction} onInstructionChange={setRefineInstruction} onGenerate={refinementEstimate.canStart ? refinementEstimate.start : undefined} generationAction={<LogoGenerationAction estimate={refinementEstimate} label="Refine" unavailable={refineInstruction.trim() ? "Not ready yet." : ""} />} />;
  return <div className={`project-logo-creation ${styles.conceptsScreen}`} aria-label="Logo creation workspace"><div>
    <div className="guided-assistant-message logo-conversation-message" aria-label="Embel">
      <EmbelIdentity label={journeyPartLabel("identity", "Logo")} />
      <h1 className="sr-only">Logo</h1>
      <p className="guided-assistant-copy">{activeBatch
        ? `Here are six concepts for ${draft?.brief.name || "your brand"}. Pick the one you like most. To change it, tell me what to adjust below.`
        : `Time for a logo. I’ll draw six concepts for ${draft?.brief.name || "your brand"}, guided by the designs you liked. First, which kinds of logo should I explore?`}</p>
      {!activeBatch && <LogoTypesQuestion value={draft?.brief.logoTypes ?? []} disabled={!draft || !editing || !autoSave}
        onChange={draft && editing && autoSave ? types => workspace.setBriefDraft({ ...draft.brief, logoTypes: types }) : undefined}
        action={<LogoGenerationAction estimate={conceptEstimate} label="Explore six concepts" unavailable={savedInputsBusy ? "Preparing saved inputs…" : !capabilities.isAvailable("identity.logo_concept") ? "Generation is currently unavailable." : "Complete your saved logo inputs to continue."} />} />}
    </div>
    {client && <LogoCandidateComparison client={client} account={account} projectId={projectId} sources={comparison} selected={selectedLogo}
      briefRevisionId={workspace.stagePayloads?.brief_references?.id} onRemove={source => setComparison(previous => previous.filter(item => logoCandidateKey(item) !== logoCandidateKey(source)))}
      onSelect={saved?.capabilities.save.status === "available" && !workspace.pending && !workspace.dirty && !draft?.conflict && editing ? source => void selectCandidate(source) : undefined} />}
    <LogoSavedInputsStatus state={savedInputs} projectId={projectId} onRefresh={() => void prepareSavedInputs(true)} />
    {recoveryTools}
    {workspace.error && <p className={styles.warning} role="alert">{workspace.error}</p>}
    {activeBatch && saved?.stages.brief_references && saved.stages.brief_references.id !== activeBatch.briefRevisionId && <p className={styles.warning}>This batch uses an earlier saved brief. Its original inputs and successful previews are kept.</p>}
    {activeBatch && newerLikes && <div className={styles.likesUpdate} role="status">
      <p>You changed your likes after these concepts were made. Use them for your next concepts?{selectedLogo ? " Your chosen logo will then need to be chosen again from the new concepts before Creative direction." : ""}</p>
      <button type="button" className={styles.secondaryButton} disabled={!editing || savedInputsBusy || generationState.phase !== "idle"} onClick={() => void prepareSavedInputs(true)}>Use my new likes</button>
    </div>}
    {activeBatch && selectionState.error && <p className={styles.warning} role="status">{selectionState.error}</p>}
    <LogoConceptGridView gallery status={activeBatch ? selectionState.busy ? "Saving your choice…" : initialConceptReadState ? initialConceptReadMessage : selectedLogo ? "Logo chosen" : "Pick the concept you like most" : undefined} versions={cardVersions} selectedVersion={selectedLogo} selectionAt={workspace.stagePayloads?.concepts?.createdAt} viewedVersions={viewedVersions}
      onViewVersion={(slotId, key, count) => setViewedVersions(previous => ({ ...previous, [slotId]: { key, count } }))}
      onSelectVersion={batchReady && saved?.capabilities.save.status === "available" && !workspace.pending && !workspace.dirty && !draft?.conflict && editing ? source => void selectCandidate(source) : undefined} filter={conceptFilter} comparison={comparison} onCompare={compareCandidate} batch={activeBatch} savedBatchUnavailable={savedBatchUnavailable} savedBatchLoading={savedBatchLoading}
      selected={selectedLogo?.kind === "concept" ? selectedLogo : null}
      onSelect={batchReady && saved?.capabilities.save.status === "available" && !workspace.pending && !workspace.dirty && editing ? source => void selectCandidate(source) : undefined}
      generation={capabilities.isAvailable("identity.logo_concept") ? { status: "available" } : { status: "unavailable", reason: "Concept generation is currently unavailable." }}
      refinement={capabilities.isAvailable("identity.logo_refine") ? { status: "available" } : { status: "unavailable", reason: "Image refinement is currently unavailable." }} plan={conceptEstimate.quote?.conceptPlan}
      renderPreview={client ? receipt => <LogoVerifiedPreview client={client} receipt={receipt} /> : undefined}
      generationActions={<>
        {!nameReadiness.supported && <p role="status">{nameReadiness.message}</p>}
        {activeBatch && <LogoGenerationAction variant="secondary" estimate={moreEstimate} label="More concepts" unavailable="" />}
        {failedSlotIds.length > 0 && <LogoGenerationAction variant="secondary" estimate={retryEstimate} label={`Retry ${failedSlotIds.length} failed concept${failedSlotIds.length === 1 ? "" : "s"}`} unavailable="" />}
      </>}
      onRequestRefine={batchReady && selectedLogo && canEstimate ? () => { refinementInput.current?.focus(); } : undefined}
      request={activeRequest} onCheckRequest={recoveryKeys.length > 0 && client && editing && !checkingRequest ? () => void checkRequest() : undefined} />
    {/* The refine box stays in one place below the concepts, so a draft survives the first set arriving. */}
    {conceptsComposer}
    {refinementHistoryState.error && <p role="status" className={styles.warning}>{refinementHistoryState.error}</p>}
    {refinementHistoryState.nextCursor && <button type="button" className={styles.secondaryButton} disabled={refinementHistoryState.loading} onClick={() => void refinementHistory?.loadMore()}>Load earlier versions</button>}
    {checkingRequest && <p className={styles.note} role="status">Checking the existing request…</p>}
    {recoveryKeys.filter(key => requestReadouts[key]?.error).map(key => <p key={key} className={styles.note} role="status">{requestReadouts[key]!.error}</p>)}
    {generation && <LogoCostConfirmation controller={generation} batch={activeBatch} />}
  </div></div>;
}
