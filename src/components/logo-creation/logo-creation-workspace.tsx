"use client";

import Link from "next/link";
import { ProjectDock, useProjectLogoEvidence } from "@/components/workspace/project-workspace";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { logoBriefDraftSchema, type LogoRasterSource } from "@/domain/logo-workspace";
import { logoUuidSchema } from "@/domain/logo-vector";
import type { LogoConceptBatch } from "@/domain/logo-jobs";
import { IMAGE_INPUT_LIMITS } from "@/domain/logo-image-limits";
import { VisualDirectionReview } from "@/features/identity-directions/components/visual-direction-review";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoCreation } from "./use-logo-creation";
import type { LogoCreationState } from "./creation-controller";
import { LogoVerifiedPreview } from "./verified-preview";
import { selectLogoCandidate, recoverLogoSelection, LogoSelectionConflictResolvedError } from "./selection-controller";
import { AccountRequestError, accountErrorMessage } from "../workspace/account-api";
import { useLogoBatchHistory } from "./use-logo-batch-history";
import { useLogoRefinementHistory } from "./use-logo-refinement-history";
import { LogoRefinementGallery } from "./refinement-gallery";
import { LogoVectorConversionControls } from "./vector-conversion-controls";
import { logoBatchRecoveryRequestKeys, checkLogoBatchRequests, type LogoBatchRequestCheck } from "./batch-history";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import { seedLogoBrief } from "./brief-model";
import { LogoBriefFields } from "./brief-form";
import { AccountLogoInputs } from "@/components/identity/account-logo-inputs";
import { LogoReferenceLimitNotice, LogoReferencePickerView } from "./reference-picker";
import { ConceptsComposer } from "./concepts-composer";
import { conceptVersions } from "./concept-versions";
import { LogoConceptGridView } from "./concept-grid";
import { LogoCostConfirmation, LogoCostConfirmationView } from "./cost-confirmation";
import { LogoCandidateComparison } from "./candidate-comparison";
import { logoCandidateKey } from "./candidate-review";
import { useLogoCandidate } from "./use-logo-candidate";
import { LogoIdentityContinuation, LogoInputStatus } from "./workflow-status";
import { prepareSavedLogoConcepts, logoDraftHasProtectedWork, type LogoSavedInputChoice } from "./saved-inputs-controller";
import { LogoSavedInputsStatus, type LogoSavedInputState } from "./saved-inputs-status";
import styles from "./logo-creation.module.css";

const noSubscription = () => () => undefined;
const EMPTY_CREATION: LogoCreationState = { phase: "idle", quote: null, request: null, error: null };
const emptyCreation = () => EMPTY_CREATION;

export function LogoCreationWorkspace({ projectId, onProjectCreated, mode = "setup" }: {
  projectId?: string;
  mode?: "setup" | "refine";
  onProjectCreated?: (projectId: string) => void;
}): React.JSX.Element {
  const { session } = useAccountSession();
  const memory = useLogoDraftMemory();
  if (session.status !== "ready") return <section className={styles.panel} aria-label="Create a logo"><h1>Create a logo</h1><AccountStatus retainedEdits={memory.hasUnsaved()} /></section>;
  if (projectId !== undefined && !logoUuidSchema.safeParse(projectId).success) return <section className={styles.panel} role="alert"><h1>Project unavailable</h1><p>Open a saved project to continue.</p><Link href="/brands">View projects</Link></section>;
  return <OwnedLogoCreation key={session.userId + ":" + session.generation + ":" + (projectId ?? "new")} account={session} projectId={projectId} mode={mode} onProjectCreated={onProjectCreated} />;
}

/** All editable brief/reference values and retained requests live in the shared memory. */
function OwnedLogoCreation({ account, projectId, onProjectCreated }: {
  account: VerifiedAccount;
  projectId?: string;
  mode?: "setup" | "refine";
  onProjectCreated?: (projectId: string) => void;
}): React.JSX.Element {
  const { isCurrent } = useAccountSession();
  const memory = useLogoDraftMemory();
  const { workspace, creation: generation, capabilities } = useLogoCreation(projectId);
  const generationState = useSyncExternalStore(generation?.subscribe ?? noSubscription, generation?.getSnapshot ?? emptyCreation, emptyCreation);
  const { client, draft, reload: reloadWorkspace } = workspace;
  const { controller: batchHistory, state: batchHistoryState } = useLogoBatchHistory(client, account, projectId);
  const { controller: refinementHistory, state: refinementHistoryState } = useLogoRefinementHistory(client, account, projectId);
  const strategyRead = useRef<AbortController | null>(null);
  const savedInputsRead = useRef<AbortController | null>(null);
  const savedInputsTrigger = useRef<HTMLElement | null>(null);
  const refinementTrigger = useRef<HTMLElement | null>(null);
  const refinementDisclosure = useRef<HTMLButtonElement | null>(null);
  const quotedPreparation = useRef<LogoSavedInputState | null>(null);
  const requestRead = useRef<AbortController | null>(null);
  const deliveredCreation = useRef<string | null>(null);
  const [strategy, setStrategy] = useState<{ busy: boolean; message: string | null; revision?: number; nameConflict: boolean }>({ busy: false, message: null, nameConflict: false });
  const [batchRead, setBatchRead] = useState<{ id: string; client: AccountLogoClient; revision: number; batch: LogoConceptBatch | null; unavailable: boolean } | null>(null);
  const [requestReadouts, setRequestReadouts] = useState<Record<string, LogoBatchRequestCheck>>({});
  const [checkingRequest, setCheckingRequest] = useState(false);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [batchReload, setBatchReload] = useState(0);
  const [comparison, setComparison] = useState<LogoRasterSource[]>([]);
  const [viewedVersions, setViewedVersions] = useState<Record<string, { key: string; count: number }>>({});
  const selectedRefinementRequests = useRef(new Set<string>());
  const refreshedRefinementRequests = useRef(new Set<string>());
  const [conceptFilter, setConceptFilter] = useState<"all" | "saved">("all");
  const [refineInstruction, setRefineInstruction] = useState("");
  const [refinementSubmitting, setRefinementSubmitting] = useState(false);
  const refinementSubmission = useRef(false);
  const [selectionState, setSelectionState] = useState<{ selected: LogoRasterSource | null; workspaceRevision: number | null; busy: boolean; error: string | null }>({ selected: null, workspaceRevision: null, busy: false, error: null });
  const selecting = useRef(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [saveReadout, setSaveReadout] = useState<{ key: string; message: string } | null>(null);
  const [savedInputs, setSavedInputs] = useState<LogoSavedInputState>({ status: "idle" });
  const savedInputsBusy = savedInputs.status === "reading" || savedInputs.status === "saving" || savedInputs.status === "prepared";
  const conceptsScreen = Boolean(projectId);
  const saved = workspace.workspace;
  useProjectLogoEvidence(saved ? { ownerId: saved.ownerId, projectId: saved.projectId, projectRevision: saved.heads.projectRevision,
    approved: Boolean(workspace.status === "ready" && !workspace.error && !workspace.pending && !workspace.dirty && !draft?.conflict && saved.approvedLogo
      && !saved.staleStages.some(({ stage }) => stage !== "directions" && stage !== "deliverables")),
    needsReview: saved.staleStages.some(({ stage }) => stage !== "directions" && stage !== "deliverables") } : null);
  const savedProjectId = saved?.projectId;
  const needsInitialization = Boolean(projectId && saved && !saved.stages.brief_references);
  const workspaceRevision = saved?.heads.workspaceRevision;
  const dispatch = generationState.request && generationState.request.status !== "not_found" && generationState.request.receipt && "jobIds" in generationState.request.receipt ? generationState.request.receipt : null;
  const batchIds = [...new Set([...(dispatch?.batchId ? [dispatch.batchId] : []), ...batchHistoryState.items.map(batch => batch.id),
    ...(workspace.stagePayloads?.concepts?.payload.batchIds ?? []).slice().reverse(), ...(selectedBatchId && batchRead?.id === selectedBatchId && batchRead.batch ? [selectedBatchId] : [])])];
  const batchId = selectedBatchId && batchIds.includes(selectedBatchId) ? selectedBatchId : batchIds[0];
  const matchingBatchRead = client && projectId && saved?.ownerId === account.userId && saved.projectId === projectId
    && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId) && batchRead?.client === client && batchRead.id === batchId ? batchRead : null;
  // Successful immutable previews do not become different bytes when a selection
  // advances workspace heads. Keep display separate from fresh action eligibility.
  const activeBatch = matchingBatchRead?.batch ?? null;
  const batchReady = !!matchingBatchRead && matchingBatchRead.revision === workspaceRevision && !matchingBatchRead.unavailable;
  const savedBatchUnavailable = Boolean(matchingBatchRead?.unavailable || !activeBatch
    && (conceptsScreen ? workspace.error || batchHistoryState.error : batchId));
  const savedBatchLoading = Boolean(conceptsScreen && !activeBatch && !savedBatchUnavailable && (workspace.status !== "ready" || !saved || !client
    || !batchHistoryState.loaded || saved.stages.concepts && !workspace.stagePayloads?.concepts || batchId));
  // Presentation only: an incomplete first read is not proof of no selection.
  // Retained payloads and history keep ordinary same-owner refreshes resolved.
  const initialConceptReadState: "loading" | "unavailable" | undefined = conceptsScreen
    && (!saved || saved.stages.concepts && !workspace.stagePayloads?.concepts || !activeBatch && (!batchHistoryState.loaded || batchId))
    ? savedBatchUnavailable ? "unavailable" : "loading" : undefined;
  const initialConceptReadMessage = initialConceptReadState === "unavailable" ? "Saved logo details unavailable." : "Loading saved logo details…";
  const pendingIntentKey = workspace.pendingIntent?.requestKey;
  const recoveryKeys = [...new Set([...(pendingIntentKey ? [pendingIntentKey] : []), ...logoBatchRecoveryRequestKeys(activeBatch)])];
  const activeRequest = generationState.request ?? recoveryKeys.map(key => requestReadouts[key]?.state).find(state => state !== null && state !== undefined) ?? null;
  const creation = workspace.pendingCreation;
  const created = creation?.state?.status === "succeeded" ? creation.state : null;

  useEffect(() => () => { strategyRead.current?.abort(); savedInputsRead.current?.abort(); requestRead.current?.abort(); }, []);

  useEffect(() => {
    if (savedInputs.status !== "prepared" || !generation || !projectId || !client || !workspace.canEdit || workspace.pending) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || quotedPreparation.current === savedInputs || !isCurrent(account) || !isAccountLogoClientCurrent(client, account, projectId)) return;
      quotedPreparation.current = savedInputs;
      const current = memory.get(projectId);
      if (!current?.workspace || logoDraftHasProtectedWork(current) || JSON.stringify(current.workspace.heads) !== JSON.stringify(savedInputs.request.expected)) {
        setSavedInputs({ status: "blocked", message: "Your logo inputs changed. Save or resolve the changes in Project context, then try again." });
        return;
      }
      setSavedInputs({ status: "reviewing_cost", source: savedInputs.source, used: savedInputs.used });
      void generation.prepare(savedInputs.request);
    });
    return () => { cancelled = true; };
  }, [account, client, generation, isCurrent, memory, projectId, savedInputs, workspace.canEdit, workspace.pending]);

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
    if (projectId || !created || !client || !onProjectCreated || deliveredCreation.current === created.requestKey) return;
    if (!isCurrent(account) || !isAccountLogoClientCurrent(client, account, null) || saved?.ownerId !== account.userId || saved.projectId !== created.projectId) return;
    deliveredCreation.current = created.requestKey;
    onProjectCreated(created.projectId);
  }, [account, client, created, isCurrent, onProjectCreated, projectId, saved]);

  useEffect(() => {
    if (!client || !projectId || !batchId || workspaceRevision === undefined) return;
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
          const retained = memory.get(projectId!);
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
  const editing = workspace.canEdit && !strategy.busy && !savedInputsBusy && !selectionState.busy;
  const saveAvailable = projectId === undefined || saved?.capabilities.save.status === "available";
  const validBrief = draft !== null && logoBriefDraftSchema.safeParse(draft.brief).success;
  const canSave = editing && validBrief && saveAvailable && !workspace.pending && !draft?.conflict;
  const pendingSave = draft?.pendingMutation?.command;
  const pendingSelection = pendingSave?.method === "selectLogoConcept" || pendingSave?.method === "selectLogoRaster" ? pendingSave : null;
  const selectedLogo = selectionState.workspaceRevision === saved?.heads.workspaceRevision
    ? selectionState.selected : workspace.stagePayloads?.concepts?.payload.selected ?? null;
  const focusedLogo = selectedLogo;
  const focusedReview = useLogoCandidate(client, account, projectId, focusedLogo);
  const focusedReceipt = focusedReview.item?.preview ?? null;
  const cardVersions = conceptVersions(activeBatch, refinementHistoryState);
  const selectedCard = Object.entries(cardVersions).find(([, versions]) => selectedLogo && versions.some(version => version.key === logoCandidateKey(selectedLogo)));
  const selectedOrdinal = activeBatch?.slots.find(slot => slot.id === selectedCard?.[0])?.ordinal;
  const selectedLabel = selectedLogo ? selectedOrdinal !== undefined ? `Concept ${selectedOrdinal + 1}${selectedLogo.kind === "refinement" ? ` · ${selectedCard?.[1].find(version => version.key === logoCandidateKey(selectedLogo))?.label ?? "Refined"}` : ""}` : "your selected logo" : undefined;
  const refinementBusy = Boolean(refinementRequestKey && ["admitted", "running", "needs_reconciliation"].includes(refinementRequestStatus ?? ""));
  const completedRefinement = refinementHistoryState.items.find(({ record, verified }) => verified && record.requestKey === refinementRequestKey && record.state === "succeeded" && record.billing.status === "recorded" && record.preview?.publicationState === "committed")?.record;
  const reviewingRefinement = generationState.quote?.request.operation === "refine_preview";
  const composerStatus = refinementSubmitting ? "Preparing your cost estimate…" : reviewingRefinement && generationState.phase === "awaiting_confirmation" ? "Review the cost to start this refinement." : reviewingRefinement && generationState.phase === "admitting" ? "Starting your refinement…" : selectionState.busy ? "Saving your selection…" : refinementBusy ? refinementRequestStatus === "needs_reconciliation" ? "Checking the original refinement request…" : "Refining your selected logo…"
    : completedRefinement ? "Your refined logo is ready on its card." : initialConceptReadState ? initialConceptReadMessage : !selectedLogo ? "Select a logo above to get started." : focusedReview.loading ? "Reading your selected logo…" : focusedReview.error ? "Your selected logo could not be verified. Try selecting it again."
    : !capabilities.isAvailable("identity.logo_refine") ? "Logo refinement is currently unavailable. Your message is kept." : "Review the cost before starting a new refinement.";

  const canDiscard = Boolean(projectId && editing && (workspace.dirty || draft?.conflict) && !workspace.pending && !checkingRequest);
  const snapshot = workspace.referenceSnapshot;
  const referenceCount = draft?.references.length ?? snapshot?.references.length ?? 0;
  const conceptReferenceLimitExceeded = referenceCount > IMAGE_INPUT_LIMITS.images;
  const canSaveReferences = Boolean(editing && snapshot && saveAvailable && !workspace.pending && !draft?.conflict);
  const saveMessage = savedInputs.status === "saving" ? "Saving…" : strategy.busy ? "Reading your saved Strategy…" : workspace.pending ? "A request is awaiting confirmation. Your edits are kept in this tab."
    : !saveAvailable ? "Saving is unavailable. " + (saved?.capabilities.save.status === "unavailable" ? saved.capabilities.save.reason : "Your edits are kept in this tab.")
    : workspace.status === "loading" ? "Loading your workspace…" : draft?.conflict ? "The saved brief has changed. Your edits are kept in this tab."
    : !validBrief ? "Enter a brand name and choose at least one logo type. Brief details must fit the save limits."
    : workspace.dirty ? "Unsaved changes are kept in this tab." : needsInitialization ? "Create a logo workspace in this saved brand when your brief is ready." : saved ? "Saved." : "Save the brief to create your project.";

  async function reviewRefinement() {
    if (refinementSubmission.current || !projectId || !generation || generation.getSnapshot().phase !== "idle" || !saved || !selectedLogo || !focusedReceipt || !editing || workspace.pending || workspace.dirty || draft?.conflict || !refineInstruction.trim() || !capabilities.isAvailable("identity.logo_refine")) return;
    const source = selectedLogo, instruction = refineInstruction.trim();
    const stableHeads = (heads: typeof saved.heads) => JSON.stringify([heads.workspaceRevision, heads.referenceRevision, heads.preferencesRevision, heads.stageRevisions]);
    refinementTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    refinementSubmission.current = true; setRefinementSubmitting(true);
    try {
      const refreshed = await workspace.reload(false);
      const latest = memory.get(projectId);
      if (!isCurrent(account)) return;
      if (refreshed !== "reloaded" || !latest?.workspace || logoDraftHasProtectedWork(latest)
        || stableHeads(latest.workspace.heads) !== stableHeads(saved.heads)) {
        setSelectionState(previous => ({ ...previous, error: "Your saved logo inputs changed. Check the selected logo, then send your changes again. Your message is kept." }));
        return;
      }
      // Wait for the refreshed account controller to commit its editability state.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (!isCurrent(account) || generation.getSnapshot().phase !== "idle") return;
      // The shared controller binds and validates the exact source/instruction.
      // Preparing only opens the review; its explicit confirmation admits work.
      await generation.prepare({ operation: "refine_preview", expected: latest.workspace.heads, source, instruction });
    } finally { refinementSubmission.current = false; setRefinementSubmitting(false); }
  }

  async function prepareSavedInputs(choice?: LogoSavedInputChoice) {
    if (!projectId || !client || !generation || !isCurrent(account) || savedInputsRead.current || strategyRead.current || selecting.current
      || generation.getSnapshot().phase !== "idle") return;
    if (!choice) savedInputsTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controller = new AbortController(); savedInputsRead.current = controller;
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    try {
      const result = await prepareSavedLogoConcepts({ ownerId: account.userId, projectId, signal: controller.signal,
        isCurrent: current, getDraft: () => memory.get(projectId), readSavedInputs: signal => client.readLogoSavedInputs(signal),
        saveBrief: brief => workspace.saveBrief(brief), readBriefRevision: (id, signal) => client.getLogoStageRevision("brief_references", id, signal),
        onProgress: status => { if (current()) setSavedInputs({ status }); },
      }, choice);
      if (current() && result.status !== "obsolete") setSavedInputs(result);
    } finally { if (savedInputsRead.current === controller) savedInputsRead.current = null; }
  }

  async function reuseStrategy() {
    if (!editing || workspace.pending || !projectId || !client || !saved || !draft || strategyRead.current) return;
    const captured = draft, controller = new AbortController(); strategyRead.current = controller;
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client!, account, projectId!) && memory.get(projectId!) === captured;
    setStrategy(value => ({ ...value, busy: true, message: null }));
    try {
      const source = await client.readStrategyContext(controller.signal);
      if (!current()) return;
      if (!source || source.ownerId !== account.userId || source.projectId !== projectId || source.revision !== saved.heads.projectRevision) {
        setStrategy(value => ({ ...value, busy: false, message: "Saved Strategy is unavailable. You can keep writing the brief." })); return;
      }
      const seeded = seedLogoBrief(source.context);
      workspace.setBriefDraft({ ...seeded.draft, logoTypes: captured.brief.logoTypes });
      setStrategy({ busy: false, message: null, revision: source.revision, nameConflict: seeded.nameConflict });
    } catch (error) {
      if (current()) setStrategy(value => ({ ...value, busy: false, message: error instanceof AccountRequestError && error.status === 409
        ? "Saved brand context changed. Refresh the saved brand before reusing Strategy. Your brief is still here."
        : "Saved Strategy could not be read. Your brief is still here." }));
    } finally {
      if (strategyRead.current === controller) { strategyRead.current = null; if (!controller.signal.aborted) setStrategy(value => ({ ...value, busy: false })); }
    }
  }

  async function checkRequest() {
    if (!projectId || !client || requestRead.current || !recoveryKeys.length) return;
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
    if (!pendingSave || !projectId || !client || requestRead.current) return;
    const key = pendingSave.body.requestKey, controller = new AbortController();
    requestRead.current = controller; setCheckingRequest(true);
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client!, account, projectId!)
      && memory.get(projectId!)?.pendingMutation?.requestKey === key;
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
    if (!client || !projectId || !isCurrent(account) || selecting.current) return;
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
          ? "Your saved workspace changed before this selection was applied. Choose your saved logo version again."
          : "Your original selection was not applied. Your saved logos and edits are kept. Refresh the saved brand after resolving any local edits, then choose your logo version again." }));
      } else if (current()) setSelectionState(previous => ({ ...previous, error: error instanceof AccountRequestError && error.status === 409
        ? "Your saved workspace changed. Check the original selection before choosing a saved logo again."
        : accountErrorMessage(error) + " Your original selection request is kept." }));
    }
    finally { selecting.current = false; if (requestRead.current === controller) requestRead.current = null; if (current()) setSelectionState(previous => ({ ...previous, busy: false })); }
  }, [client, projectId, account, isCurrent, memory, reloadWorkspace]);

  useEffect(() => {
    if (!completedRefinement || !projectId || !selectedLogo || completedRefinement.source.kind === "vector" || generationState.phase !== "idle"
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
    if (!canDiscard || !projectId || requestRead.current) return;
    const latest = memory.get(projectId);
    if (!latest || latest.pendingCreation || latest.pendingMutation || latest.pendingIntent || latest.pendingExport) return;
    setConfirmReload(false);
    setStrategy({ busy: false, message: null, nameConflict: false });
    void workspace.reload(true);
  }

  function compareCandidate(source: LogoRasterSource) {
    const removing = comparison.some(item => logoCandidateKey(item) === logoCandidateKey(source));
    setComparison(previous => previous.some(item => logoCandidateKey(item) === logoCandidateKey(source))
      ? previous.filter(item => logoCandidateKey(item) !== logoCandidateKey(source))
      : previous.length < 2 ? [...previous, source] : previous);
    if (!removing) requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-logo-comparison]")?.focus());
  }

  function compareWithSource(parent: LogoRasterSource, source: LogoRasterSource) {
    setComparison([parent, source]);
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-logo-comparison]")?.focus());
  }

  const statusTools = <>
    {saved && <LogoInputStatus workspace={saved} />}
    {saved && <VisualDirectionReview projectId={saved.projectId} />}
  </>;
  const inputTools = <>
    {!activeBatch && <div className="project-logo-start"><h2>{draft?.brief.name || "Your logo starts here"}</h2><p>Save a brief in Project context, then review the available generation options. Only verified image results will appear here.</p></div>}
    {strategy.message && <p className={styles.warning} role="status">{strategy.message}</p>}
    {saved && client ? <AccountLogoInputs account={account} workspace={saved} client={client} mode="references" canWrite={editing && !workspace.pending} selections={draft?.references} savedReferences={snapshot?.references} onSelectionsChange={editing && snapshot && !workspace.pending ? workspace.setReferenceDraft : undefined} /> : <LogoReferencePickerView references={snapshot?.references} selections={draft?.references}
      onChange={editing && snapshot && !workspace.pending ? workspace.setReferenceDraft : undefined}
      statusMessage={snapshot ? "Save references to keep any changes to these aspects. References guide an original result; they do not grant permission to copy another logo."
        : draft?.references.length ? "Your reference selections are kept. Their saved details are currently unavailable."
        : projectId ? "Saved reference details are unavailable. Your selections will be kept when they can be read." : "References are optional. Save your brief before attaching references."} />}
    <LogoReferenceLimitNotice count={referenceCount} />
    {snapshot && <div className={styles.panel}><button className={styles.primaryButton} type="button" disabled={!canSaveReferences} onClick={() => { if (canSaveReferences && draft) void workspace.saveReferences(draft.references); }}>Save references</button></div>}
    {batchId && !activeBatch && <p className={styles.note} role="status">{batchRead?.id === batchId && batchRead.unavailable ? "Saved concepts are unavailable. Their original records are kept." : "Loading saved concepts…"}</p>}
    {projectId && <section className={styles.panel} aria-label="Saved explorations">
      <h2>Saved explorations</h2>
      {batchHistoryState.loading && <p className={styles.note} role="status">Reading saved explorations…</p>}
      {batchHistoryState.error && <p className={styles.warning} role="status">{batchHistoryState.error}</p>}
      {batchHistoryState.loaded && !batchHistoryState.loading && !batchHistoryState.error && batchIds.length === 0 && <p className={styles.note}>No saved exploration has been requested yet.</p>}
      {batchIds.length > 0 && <label className={styles.field}><span>Concept batch</span><select value={batchId} onChange={event => setSelectedBatchId(event.currentTarget.value)}>{batchIds.map((id, index) => <option key={id} value={id}>Exploration {index + 1}{batchHistoryState.items.find(batch => batch.id === id)?.createdAt ? ` · ${new Date(batchHistoryState.items.find(batch => batch.id === id)!.createdAt).toLocaleString()}` : ""}</option>)}</select></label>}
      <div className={styles.actions}>
        <button className={styles.secondaryButton} type="button" disabled={!batchHistory || batchHistoryState.loading} onClick={() => void batchHistory?.refresh()}>Refresh saved explorations</button>
        {batchHistoryState.nextCursor && <button className={styles.secondaryButton} type="button" disabled={batchHistoryState.loading} onClick={() => void batchHistory?.loadMore()}>Load older explorations</button>}
      </div>
    </section>}
  </>;
  const advancedTools = <>
    {projectId && <LogoRefinementGallery history={refinementHistoryState} selected={selectedLogo} briefRevisionId={workspace.stagePayloads?.brief_references?.id}
      onInspect={source => void selectCandidate(source)} comparison={comparison} onCompare={compareCandidate} onCompareSource={compareWithSource}
      refinementAvailable={capabilities.isAvailable("identity.logo_refine")}
      renderPreview={client ? receipt => <LogoVerifiedPreview client={client} receipt={receipt} alt="Image preview of saved logo refinement" /> : undefined}
      onSelect={saved?.capabilities.save.status === "available" && !workspace.pending && !workspace.dirty && !draft?.conflict && editing ? source => void selectCandidate(source) : undefined}
      onRefresh={refinementHistory ? () => void refinementHistory.refresh() : undefined}
      onLoadMore={refinementHistory ? () => void refinementHistory.loadMore() : undefined}
      onRequestRefine={!quoteReviewBlocked && generation && saved && !workspace.pending && !workspace.dirty && !draft?.conflict && refineInstruction.trim() ? source => void generation.prepare({ operation: "refine_preview", expected: saved.heads, source, instruction: refineInstruction }) : undefined} />}
    {saved && <LogoVectorConversionControls
      context={{ ownerId: saved.ownerId, projectId: saved.projectId, generation: account.generation, expected: saved.heads, source: selectedLogo }}
      getCurrentContext={() => {
        if (!projectId || !client || !isCurrent(account) || !isAccountLogoClientCurrent(client, account, projectId)
          || !editing || !capabilities.isAvailable("identity.logo_vectorize")) return null;
        const current = memory.get(projectId);
        if (!current?.workspace || current.workspace.ownerId !== account.userId || current.workspace.projectId !== projectId
          || current.dirty || current.vectorDraft || current.directionDraft || current.conflict
          || current.pendingCreation || current.pendingMutation || current.pendingIntent || current.pendingExport) return null;
        return { ownerId: current.workspace.ownerId, projectId, generation: account.generation,
          expected: current.workspace.heads, source: selectedLogo };
      }}
      controller={generation}
      available={capabilities.isAvailable("identity.logo_vectorize")}
      blocked={!editing || workspace.pending || workspace.dirty || !!draft?.conflict}
      onRefreshAvailability={() => { void capabilities.refresh(); }}
    />}
    {saved && !needsInitialization && <LogoIdentityContinuation workspace={saved} blocked={workspace.pending || workspace.dirty || !!draft?.conflict} hasSelection={Boolean(selectedLogo)} />}
  </>;

  const conceptsComposer = conceptsScreen && projectId ? <ConceptsComposer disclosureRef={refinementDisclosure} projectId={projectId} selectionReadState={initialConceptReadState} selectedLabel={selectedLabel} selectedPreview={focusedReceipt && client ? <LogoVerifiedPreview client={client} receipt={focusedReceipt} alt="Selected logo" /> : undefined} status={composerStatus} onShowResult={completedRefinement ? () => { const slotId = Object.entries(cardVersions).find(([, versions]) => versions.some(version => version.source.kind === "refinement" && version.source.rasterRevisionId === completedRefinement.id))?.[0]; if (slotId) document.querySelector<HTMLElement>(`[data-concept-slot="${slotId}"]`)?.scrollIntoView({ block: "center" }); } : undefined} instruction={refineInstruction} onInstructionChange={setRefineInstruction} onReview={generationState.phase === "idle" && !refinementSubmitting && !refinementBusy && selectedLogo && focusedReceipt && generation && saved && editing && !workspace.pending && !workspace.dirty && !draft?.conflict && refineInstruction.trim() && !quoteReviewBlocked && capabilities.isAvailable("identity.logo_refine") ? () => { void reviewRefinement(); } : undefined}>
      <LogoBriefFields draft={draft?.brief} onChange={editing ? workspace.setBriefDraft : undefined} onReuseStrategy={editing && projectId && saved && !workspace.pending ? () => void reuseStrategy() : undefined} nameConflict={strategy.nameConflict} sourceProjectRevision={strategy.revision} saveMessage={saveMessage} saveLabel={needsInitialization ? "Create logo workspace" : "Save brief"} onSave={canSave ? () => { if (draft) void workspace.saveBrief(draft.brief); } : undefined} />
      <details className={styles.contextDetails}><summary>Saved inputs and recovery</summary>      <p className={styles.muted}>Start with a brief, choose the kinds of logo you want to explore, and keep your work in a saved project.</p>
      {savedProjectId && <div className={styles.actions}>
        <Link className={styles.secondaryButton} href={"/brands/account/" + savedProjectId}>Open project</Link>
        <Link className={styles.secondaryButton} href={"/brands/account/" + savedProjectId + "/identity"}>Open moodboard and saved systems</Link>
      </div>}
      {savedProjectId && <Link className={styles.secondaryButton} href={"/brands/account/" + savedProjectId + "/logo/vector"}>Advanced vector editor</Link>}
      {needsInitialization && <p className={styles.note}>Use Reuse Strategy to copy this project’s selected name, audience and personality into an editable logo brief. Choose your logo types, then create the logo workspace.</p>}
      {savedProjectId && !workspace.pending && !workspace.dirty && !draft?.conflict && <button className={styles.secondaryButton} type="button" onClick={() => { setStrategy({ busy: false, message: null, nameConflict: false }); void workspace.reload(false); }}>Refresh saved brand</button>}
      {!savedProjectId && <p className={styles.note}>Save your brief to open the logo editor.</p>}
      {created && !onProjectCreated && <p><Link href={"/brands/account/" + created.projectId + "/logo"}>Continue with your saved logo brief</Link></p>}
      {selectionState.error && <p className={styles.warning} role="alert">{selectionState.error}</p>}
      {pendingSelection && <div className={styles.actions}><p className={styles.note}>The original logo selection is awaiting confirmation. Your saved previews are retained.</p><button className={styles.secondaryButton} type="button" disabled={selectionState.busy} onClick={() => void selectCandidate()}>Check original selection</button><button className={styles.secondaryButton} type="button" disabled={selectionState.busy || draft?.conflict} onClick={() => void selectCandidate(undefined, true)}>Retry original selection</button></div>}
      {workspace.error && <p className={styles.warning} role="alert">{workspace.error}</p>}
      {workspace.status === "error" && !workspace.pending && <button className={styles.secondaryButton} type="button" onClick={() => void workspace.reload(false)}>Try loading again</button>}
      {creation && !created && <div className={styles.actions}>
        <p className={styles.note}>The save has not been confirmed. Check it or retry the same save; your original brief is kept.</p>
        <button className={styles.secondaryButton} type="button" disabled={!editing} onClick={() => void workspace.checkProjectCreation()}>Check project save</button>
        <button className={styles.secondaryButton} type="button" disabled={!editing} onClick={() => void workspace.retryProjectCreation()}>Retry original project save</button>
      </div>}
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
{statusTools}{inputTools}{advancedTools}
</details>
    </ConceptsComposer> : null;
  return <div className={`project-logo-creation project-workbench ${conceptsScreen ? styles.conceptsScreen : ""} `} aria-label="Logo creation workspace"><div className="project-workbench-canvas">
    {conceptsScreen && projectId && <Link className={styles.backToInspiration} href={`/brands/account/${projectId}/inspiration`}>← Back to inspiration</Link>}
    <header className={styles.workspaceHeader}>
      <h1>{projectId ? "Explore your logo" : "Give your brand a visual voice"}</h1>
      <p className={styles.muted}>{conceptsScreen ? (activeBatch ? `Six directions for ${draft?.brief.name || "your brand"}` : "Six directions, shaped by your brand and inspiration.") : "Review and refine your saved logo."}</p>
      {!conceptsScreen && <>      <p className={styles.muted}>Start with a brief, choose the kinds of logo you want to explore, and keep your work in a saved project.</p>
      {savedProjectId && <div className={styles.actions}>
        <Link className={styles.secondaryButton} href={"/brands/account/" + savedProjectId}>Open project</Link>
        <Link className={styles.secondaryButton} href={"/brands/account/" + savedProjectId + "/identity"}>Open moodboard and saved systems</Link>
      </div>}
      {savedProjectId && <Link className={styles.secondaryButton} href={"/brands/account/" + savedProjectId + "/logo/vector"}>Advanced vector editor</Link>}
      {needsInitialization && <p className={styles.note}>Use Reuse Strategy to copy this project’s selected name, audience and personality into an editable logo brief. Choose your logo types, then create the logo workspace.</p>}
      {savedProjectId && !workspace.pending && !workspace.dirty && !draft?.conflict && <button className={styles.secondaryButton} type="button" onClick={() => { setStrategy({ busy: false, message: null, nameConflict: false }); void workspace.reload(false); }}>Refresh saved brand</button>}
      {!savedProjectId && <p className={styles.note}>Save your brief to open the logo editor.</p>}
      {created && !onProjectCreated && <p><Link href={"/brands/account/" + created.projectId + "/logo"}>Continue with your saved logo brief</Link></p>}
      {selectionState.error && <p className={styles.warning} role="alert">{selectionState.error}</p>}
      {pendingSelection && <div className={styles.actions}><p className={styles.note}>The original logo selection is awaiting confirmation. Your saved previews are retained.</p><button className={styles.secondaryButton} type="button" disabled={selectionState.busy} onClick={() => void selectCandidate()}>Check original selection</button><button className={styles.secondaryButton} type="button" disabled={selectionState.busy || draft?.conflict} onClick={() => void selectCandidate(undefined, true)}>Retry original selection</button></div>}
      {workspace.error && <p className={styles.warning} role="alert">{workspace.error}</p>}
      {workspace.status === "error" && !workspace.pending && <button className={styles.secondaryButton} type="button" onClick={() => void workspace.reload(false)}>Try loading again</button>}
      {creation && !created && <div className={styles.actions}>
        <p className={styles.note}>The save has not been confirmed. Check it or retry the same save; your original brief is kept.</p>
        <button className={styles.secondaryButton} type="button" disabled={!editing} onClick={() => void workspace.checkProjectCreation()}>Check project save</button>
        <button className={styles.secondaryButton} type="button" disabled={!editing} onClick={() => void workspace.retryProjectCreation()}>Retry original project save</button>
      </div>}
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
</>}
    </header>
    {!conceptsScreen && statusTools}
    {client && projectId && <LogoCandidateComparison client={client} account={account} projectId={projectId} sources={comparison} selected={selectedLogo}
      briefRevisionId={workspace.stagePayloads?.brief_references?.id} onRemove={source => setComparison(previous => previous.filter(item => logoCandidateKey(item) !== logoCandidateKey(source)))}
      onSelect={saved?.capabilities.save.status === "available" && !workspace.pending && !workspace.dirty && !draft?.conflict && editing ? source => void selectCandidate(source) : undefined} />}
    {!conceptsScreen && inputTools}
    {conceptsScreen && projectId && <LogoSavedInputsStatus state={savedInputs} projectId={projectId} onChoice={choice => void prepareSavedInputs(choice)} onCancel={() => setSavedInputs({ status: "idle" })} onRefresh={() => { void capabilities.refresh(); void workspace.reload(false); }} />}
    {conceptsScreen && <div className={styles.conceptFilters} aria-label="Concept filters"><button type="button" aria-pressed={conceptFilter === "all"} onClick={() => setConceptFilter("all")}>All concepts · 6</button><button type="button" aria-pressed={conceptFilter === "saved"} onClick={() => setConceptFilter("saved")}>Selected</button><button type="button" disabled title="Concept likes are not available yet">Liked</button></div>}
    {workspace.error && conceptsScreen && <p className={styles.warning} role="alert">{workspace.error}</p>}
    {activeBatch && saved?.stages.brief_references && saved.stages.brief_references.id !== activeBatch.briefRevisionId && <p className={styles.warning}>This batch uses an earlier saved brief. Its original inputs and successful previews are kept.</p>}
    {conceptsScreen && <p className={styles.note} role="status">{selectionState.busy ? "Saving selection…" : selectionState.error ?? (initialConceptReadState ? initialConceptReadMessage : selectedLogo ? "Project logo choice saved." : "Choose a logo for this project.")}</p>}
    {conceptsComposer}
    <LogoConceptGridView gallery={conceptsScreen} versions={cardVersions} selectedVersion={selectedLogo} selectionAt={workspace.stagePayloads?.concepts?.createdAt} viewedVersions={viewedVersions}
      onViewVersion={(slotId, key, count) => setViewedVersions(previous => ({ ...previous, [slotId]: { key, count } }))}
      onSelectVersion={batchReady && saved?.capabilities.save.status === "available" && !workspace.pending && !workspace.dirty && !draft?.conflict && editing ? source => void selectCandidate(source) : undefined} filter={conceptFilter} comparison={comparison} onCompare={compareCandidate} batch={activeBatch} savedBatchUnavailable={savedBatchUnavailable} savedBatchLoading={savedBatchLoading}
      selected={selectedLogo?.kind === "concept" ? selectedLogo : null}
      onSelect={batchReady && saved?.capabilities.save.status === "available" && !workspace.pending && !workspace.dirty && editing ? source => void selectCandidate(source) : undefined}
      generation={capabilities.isAvailable("identity.logo_concept") ? { status: "available" } : { status: "unavailable", reason: "Concept generation is currently unavailable." }}
      refinement={capabilities.isAvailable("identity.logo_refine") ? { status: "available" } : { status: "unavailable", reason: "Image refinement is currently unavailable." }} plan={generationState.quote?.conceptPlan}
      renderPreview={client ? receipt => <LogoVerifiedPreview client={client} receipt={receipt} /> : undefined}
      allowInputPreparation={conceptsScreen}
      onRequestConcepts={conceptsScreen
        ? !savedBatchLoading && !savedBatchUnavailable && !conceptReferenceLimitExceeded && !quoteReviewBlocked && batchHistoryState.loaded && !batchHistoryState.error && !batchId && generation && saved && editing && !workspace.pending && generationState.phase === "idle"
          ? () => void prepareSavedInputs() : undefined
        : !conceptReferenceLimitExceeded && !quoteReviewBlocked && batchHistoryState.loaded && !batchHistoryState.error && generation && saved && workspace.stagePayloads?.brief_references && !workspace.pending && !workspace.dirty ? () => {
        const brief = workspace.stagePayloads!.brief_references!;
        void generation.prepare({ operation: "concepts", expected: saved.heads, briefRevisionId: brief.id, referenceSnapshotId: brief.payload.referenceSnapshotId });
      } : undefined}
      onRequestMore={batchReady && !conceptReferenceLimitExceeded && !quoteReviewBlocked && generation && saved && workspace.stagePayloads?.brief_references && !workspace.pending && !workspace.dirty ? () => {
        const brief = workspace.stagePayloads!.brief_references!;
        void generation.prepare({ operation: "more_concepts", expected: saved.heads, briefRevisionId: brief.id, referenceSnapshotId: brief.payload.referenceSnapshotId });
      } : undefined}
      onRequestRetryFailed={batchReady && !quoteReviewBlocked && generation && saved && activeBatch && !workspace.pending && !workspace.dirty ? failedSlotIds => void generation.prepare({ operation: "retry_failed", expected: saved.heads, sourceBatchId: activeBatch.id, failedSlotIds }) : undefined}
      onRequestRefine={batchReady && !quoteReviewBlocked && generation && saved && !workspace.pending && !workspace.dirty && refineInstruction.trim() ? source => void generation.prepare({ operation: "refine_preview", expected: saved.heads, source, instruction: refineInstruction }) : undefined}
      request={activeRequest} onCheckRequest={recoveryKeys.length > 0 && client && editing && !checkingRequest ? () => void checkRequest() : undefined} />
    {conceptsScreen && projectId && <div className={styles.continueToBoard}>{workspace.stagePayloads?.concepts?.payload.selected && !selectionState.busy
      ? <Link className={styles.primaryButton} href={`/brands/account/${projectId}/brand-board`}>Continue to brand board →</Link>
      : <button className={styles.primaryButton} type="button" disabled title={initialConceptReadState ? initialConceptReadMessage : "Select a logo and wait for it to save"}>Continue to brand board →</button>}</div>}
    {conceptsScreen && refinementHistoryState.error && <p role="status" className={styles.warning}>{refinementHistoryState.error}</p>}
    {conceptsScreen && refinementHistoryState.nextCursor && <button type="button" className={styles.secondaryButton} disabled={refinementHistoryState.loading} onClick={() => void refinementHistory?.loadMore()}>Load earlier versions</button>}
    {!conceptsScreen && advancedTools}
    {checkingRequest && <p className={styles.note} role="status">Checking the existing request…</p>}
    {recoveryKeys.filter(key => requestReadouts[key]?.error).map(key => <p key={key} className={styles.note} role="status">Request {key.slice(0, 8)}: {requestReadouts[key]!.error}</p>)}
    {generation ? <LogoCostConfirmation controller={generation} batch={activeBatch} fallbackFocusRef={conceptsScreen && generationState.quote?.request.operation === "refine_preview" ? refinementDisclosure : undefined} returnFocusRef={generationState.quote?.request.operation === "concepts" ? savedInputsTrigger : generationState.quote?.request.operation === "refine_preview" ? refinementTrigger : undefined} /> : !initialConceptReadState && <LogoCostConfirmationView batch={activeBatch} billing={activeRequest && activeRequest.status !== "not_found" ? activeRequest.billing : null} />}
  </div>{!conceptsScreen && <ProjectDock title="Logo setup" context={<p>{draft?.brief.name || "No saved brand name"}</p>}>
    <LogoBriefFields draft={draft?.brief} onChange={editing ? value => {
      if (value.name !== draft?.brief.name) setStrategy(previous => ({ ...previous, nameConflict: false }));
      workspace.setBriefDraft(value);
    } : undefined} onReuseStrategy={editing && projectId && saved && !workspace.pending ? () => void reuseStrategy() : undefined}
      nameConflict={strategy.nameConflict} sourceProjectRevision={strategy.revision} saveMessage={saveMessage} saveLabel={needsInitialization ? "Create logo workspace" : "Save brief"} onSave={canSave ? () => {
        if (!draft || !logoBriefDraftSchema.safeParse(draft.brief).success) return;
        if (projectId) void workspace.saveBrief(draft.brief); else void workspace.startProject(draft.brief);
      } : undefined} />
    {(activeBatch || refinementHistoryState.items.length > 0 || focusedLogo) && <label className={styles.field}><span>{focusedLogo ? "Revision request for inspected image" : "Revision request for selected image"}</span><textarea value={refineInstruction} maxLength={2000} onChange={event => setRefineInstruction(event.currentTarget.value)} placeholder="Describe what to change in the selected image preview" /><span className={styles.note}>{refineInstruction.length} / 2,000 characters. Each revision keeps its source and requires a separate cost approval. At most {IMAGE_INPUT_LIMITS.images - 1} saved references can accompany the original image.</span></label>}
    {focusedLogo && <button type="button" className={styles.primaryButton} disabled={!generation || !saved || !focusedReceipt || !editing || workspace.pending || workspace.dirty || !!draft?.conflict || !refineInstruction.trim() || quoteReviewBlocked || !capabilities.isAvailable("identity.logo_refine")} onClick={() => { if (generation && saved && focusedLogo && focusedReceipt) void generation.prepare({ operation: "refine_preview", expected: saved.heads, source: focusedLogo, instruction: refineInstruction }); }}>Review revision cost</button>}


  </ProjectDock>}</div>;
}
