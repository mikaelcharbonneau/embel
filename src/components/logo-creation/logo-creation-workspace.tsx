"use client";

import Link from "next/link";
import { useProjectLogoEvidence } from "@/components/workspace/project-workspace";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { LogoRasterSource } from "@/domain/logo-workspace";
import { logoUuidSchema } from "@/domain/logo-vector";
import type { LogoConceptBatch, LogoQuoteRequest } from "@/domain/logo-jobs";
import { brandTextReadiness } from "@/domain/brand-board-fonts";
import { IMAGE_INPUT_LIMITS } from "@/domain/logo-image-limits";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoCreation } from "./use-logo-creation";
import { useGenerationEstimate, type LogoEngineStarter } from "./use-generation-estimate";
import { useLogoEngine } from "./use-logo-engine";
import { LOGO_ENGINE_KINDS, logoDrawingSlotIds, logoRefineRequestStatus, logoRunBatchId, logoUndrawnSlotIds } from "@/domain/logo-engine";
import { LogoGenerationAction } from "./generation-action";
import { acceptedConceptAttempt } from "./presentation";
import { LogoVerifiedPreview } from "./verified-preview";
import { selectLogoCandidate, recoverLogoSelection, LogoSelectionConflictResolvedError } from "./selection-controller";
import { useInspirationLikes } from "@/components/workspace/inspiration-likes-signal";
import { AccountRequestError, accountErrorMessage } from "../workspace/account-api";
import { useLogoBatchHistory } from "./use-logo-batch-history";
import { useLogoRefinementHistory } from "./use-logo-refinement-history";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import { ConceptsComposer } from "./concepts-composer";
import { conceptVersions } from "./concept-versions";
import { LogoConceptGridView } from "./concept-grid";
import { LogoCandidateComparison } from "./candidate-comparison";
import { logoCandidateKey } from "./candidate-review";
import { useLogoCandidate } from "./use-logo-candidate";
import { LogoDownloadControls } from "./logo-download-controls";
import { prepareSavedLogoConcepts, logoDraftHasProtectedWork } from "./saved-inputs-controller";
import { LogoSavedInputsStatus, type LogoSavedInputState } from "./saved-inputs-status";
import { LogoTypesQuestion, LogoTypesSummary } from "./logo-types-question";
import { EmbelIdentity } from "@/components/workspace/embel-identity";
import { journeyPartLabel } from "@/domain/journey";
import styles from "./logo-creation.module.css";
import stage from "@/styles/branding-stage.module.css";

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
  const { workspace } = useLogoCreation(projectId);
  const { client, draft, reload: reloadWorkspace } = workspace;
  // Concepts, refinements and style notes run on the generation engine. Turning any Logo
  // kind off is a stop switch: drawing shows as unavailable and saved logos stay.
  const logoEngine = useLogoEngine(account, projectId);
  const engineOn = logoEngine.engine === true;
  const activeConceptRun = engineOn ? logoEngine.active(LOGO_ENGINE_KINDS.concepts) : null;
  const latestConceptRun = engineOn ? logoEngine.latest(LOGO_ENGINE_KINDS.concepts) : null;
  const activeRefineRun = engineOn ? logoEngine.active(LOGO_ENGINE_KINDS.refine) : null;
  const latestRefineRun = engineOn ? logoEngine.latest(LOGO_ENGINE_KINDS.refine) : null;
  const engineRefine = latestRefineRun && logoEngine.followed.has(latestRefineRun.id) ? latestRefineRun : null;
  const engineBatchId = logoRunBatchId(activeConceptRun) ?? (latestConceptRun && logoEngine.followed.has(latestConceptRun.id) ? logoRunBatchId(latestConceptRun) : null);
  const engineRun = activeConceptRun ?? activeRefineRun;
  const canConcept = engineOn, canRefine = engineOn;
  const drawingUnavailable = logoEngine.engine === false ? "Logo drawing is unavailable right now. Your logos are saved." : "Getting ready…";
  const { controller: batchHistory, state: batchHistoryState } = useLogoBatchHistory(client, account, projectId);
  const { controller: refinementHistory, state: refinementHistoryState } = useLogoRefinementHistory(client, account, projectId);
  const savedInputsRead = useRef<AbortController | null>(null);
  const refinementInput = useRef<HTMLTextAreaElement | null>(null);
  const preparedInputsKey = useRef<string | null>(null);
  const requestRead = useRef<AbortController | null>(null);
  const [batchRead, setBatchRead] = useState<{ id: string; client: AccountLogoClient; revision: number; batch: LogoConceptBatch | null; unavailable: boolean } | null>(null);
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
  const batchIds = [...new Set([...(engineBatchId ? [engineBatchId] : []), ...batchHistoryState.items.map(batch => batch.id),
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
  const drawingSlotIds = logoDrawingSlotIds(activeConceptRun, activeBatch);
  const undrawnSlotIds = logoUndrawnSlotIds(latestConceptRun && logoRunBatchId(latestConceptRun) === activeBatch?.id ? latestConceptRun : null, activeBatch);
  const engineDrawing = useRef(false);
  const activeConceptRunId = activeConceptRun?.id ?? null;
  useLayoutEffect(() => { engineDrawing.current = activeConceptRunId !== null; }, [activeConceptRunId]);

  useEffect(() => () => { savedInputsRead.current?.abort(); requestRead.current?.abort(); }, []);

  // An engine refinement records its result under the run's id.
  const refinementRequestKey = engineRefine ? engineRefine.id : null;
  const refinementRequestStatus = engineRefine ? logoRefineRequestStatus(engineRefine) : undefined;
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
        if (engineDrawing.current) timer = setTimeout(() => void read(), 3000);
      } catch {
        if (current()) setBatchRead(previous => previous && previous.client === client && previous.id === batchId ? { ...previous, unavailable: true } : { id: batchId!, client: client!, revision: workspaceRevision!, batch: null, unavailable: true });
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [account, activeConceptRunId, batchId, batchReload, client, isCurrent, memory, projectId, workspaceRevision]);

  const endedRound = useRef<string | null>(null);
  useEffect(() => {
    if (activeConceptRunId) { endedRound.current = activeConceptRunId; return; }
    if (!endedRound.current) return;
    endedRound.current = null;
    void batchHistory?.refresh();
    setBatchReload(value => value + 1);
    const retained = memory.get(projectId);
    if (retained && !retained.pendingIntent && !retained.dirty) void reloadWorkspace(false);
  }, [activeConceptRunId, batchHistory, memory, projectId, reloadWorkspace]);

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
  const refinementBusy = Boolean(refinementRequestKey && ["admitted", "running"].includes(refinementRequestStatus ?? ""));
  const completedRefinement = refinementHistoryState.items.find(({ record, verified }) => verified && record.requestKey === refinementRequestKey && record.state === "succeeded" && record.billing.status === "recorded" && record.preview?.publicationState === "committed")?.record;
  const composerStatus = selectionState.busy ? "Saving your choice…" : refinementBusy ? "Refining your logo…"
    : completedRefinement ? "Your refined logo is ready on its card." : initialConceptReadState ? initialConceptReadMessage : !selectedLogo ? "Select a logo above to get started." : focusedReview.loading ? "Loading your chosen logo…" : focusedReview.error ? "Your chosen logo could not be loaded. Try choosing it again."
    : !canRefine ? logoEngine.engine === false ? "Changing logos is unavailable right now. Your message is kept." : "" : "";

  // Logo types stay editable once concepts exist; a change saves the brief and
  // applies to the next set (More concepts). Not while a set is still drawing.
  const [changingTypes, setChangingTypes] = useState(false);
  const batchDrawing = Boolean(activeBatch?.slots.some(slot => ["queued", "running"].includes(slot.attempts.at(-1)?.state ?? "")));
  const canChangeTypes = Boolean(draft && editing && !needsInitialization && !batchDrawing);
  // A saved brief change makes the chosen logo's concepts outdated on the server:
  // Creative direction then needs a concept from a set made with the current brief.
  const chosenLogoOutdated = Boolean(selectedLogo && saved?.staleStages.some(({ stage }) => stage === "concepts"));
  const canDiscard = Boolean(editing && (workspace.dirty || draft?.conflict) && !workspace.pending && !checkingRequest);
  const snapshot = workspace.referenceSnapshot;
  const referenceCount = draft?.references.length ?? snapshot?.references.length ?? 0;
  const conceptReferenceLimitExceeded = referenceCount > IMAGE_INPUT_LIMITS.images;
  const autoSave = !needsInitialization;

  const nameReadiness = brandTextReadiness(draft?.brief.name ?? "");
  const canPrepareInputs = Boolean(saved && editing && !workspace.pending && !workspace.dirty && !draft?.conflict);
  const canEstimate = nameReadiness.supported && canPrepareInputs;
  const brief = workspace.stagePayloads?.brief_references;
  const [engineErrorKey, setEngineErrorKey] = useState<string | null>(null);
  const engineStarter: LogoEngineStarter | null = engineOn ? {
    busy: logoEngine.starting || Boolean(engineRun), error: logoEngine.error, errorKey: engineErrorKey, clearError: logoEngine.clearError,
    start(request) {
      setEngineErrorKey(JSON.stringify(request));
      if (request.operation === "refine_preview") void logoEngine.start(LOGO_ENGINE_KINDS.refine, { expected: request.expected, source: request.source, instruction: request.instruction });
      else if (request.operation === "retry_failed") void logoEngine.start(LOGO_ENGINE_KINDS.concepts, { operation: "retry_failed", expected: request.expected, sourceBatchId: request.sourceBatchId, failedSlotIds: request.failedSlotIds });
      else if (request.operation === "concepts" || request.operation === "more_concepts") void logoEngine.start(LOGO_ENGINE_KINDS.concepts, { operation: request.operation, expected: request.expected, briefRevisionId: request.briefRevisionId });
    },
  } : null;
  const conceptsRequest: LogoQuoteRequest | null = !activeBatch && !batchId && !savedBatchLoading && !savedBatchUnavailable && canEstimate && !conceptReferenceLimitExceeded && canConcept
    ? savedInputs.status === "prepared" && JSON.stringify(savedInputs.request.expected) === JSON.stringify(saved?.heads) ? savedInputs.request : null : null;
  const conceptEstimate = useGenerationEstimate(conceptsRequest, engineStarter);
  const moreEstimate = useGenerationEstimate(canEstimate && batchReady && saved && brief && !conceptReferenceLimitExceeded && canConcept
    ? { operation: "more_concepts", expected: saved.heads, briefRevisionId: brief.id, referenceSnapshotId: brief.payload.referenceSnapshotId } : null, engineStarter);
  const failedSlotIds = activeBatch?.slots.filter(slot => !acceptedConceptAttempt(slot) && slot.attempts.at(-1)?.state === "failed" && slot.attempts.at(-1)?.billing.status === "recorded").map(slot => slot.id) ?? [];
  const retryEstimate = useGenerationEstimate(canEstimate && batchReady && saved && activeBatch && failedSlotIds.length && canConcept && drawingSlotIds.size === 0
    ? { operation: "retry_failed", expected: saved.heads, sourceBatchId: activeBatch.id, failedSlotIds } : null, engineStarter);
  const refinementEstimate = useGenerationEstimate(canEstimate && saved && selectedLogo && focusedReceipt && !refinementBusy && refineInstruction.trim() && canRefine
    ? { operation: "refine_preview", expected: saved.heads, source: selectedLogo, instruction: refineInstruction.trim() } : null, engineStarter);
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
    if (batchId || savedBatchLoading || savedInputsBusy || !["idle", "prepared", "blocked"].includes(savedInputs.status)) return;
    seenLikes.current = likes;
    const timer = setTimeout(refreshForLikes, 0);
    return () => clearTimeout(timer);
  }, [likes, batchId, savedBatchLoading, savedInputsBusy, savedInputs.status]);
  const preparationKey = saved ? JSON.stringify(saved.heads) : null;
  useEffect(() => {
    if (!preparationKey || !canPrepareInputs || batchId || savedBatchLoading || savedBatchUnavailable
      || !["idle", "prepared"].includes(savedInputs.status) || preparedInputsKey.current === preparationKey) return;
    const timer = setTimeout(() => { preparedInputsKey.current = preparationKey; prepareLatestInputs(); }, 0);
    return () => clearTimeout(timer);
  }, [preparationKey, canPrepareInputs, batchId, savedBatchLoading, savedBatchUnavailable, savedInputs.status]);

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
    if (!likesCheckKey || likesCheck?.key === likesCheckKey || savedInputsBusy) return;
    const timer = setTimeout(() => { void checkLikes(likesCheckKey); }, 0);
    return () => clearTimeout(timer);
  }, [likesCheckKey, likesCheck?.key, savedInputsBusy]);
  const newerLikes = Boolean(likesCheckKey && likesCheck?.key === likesCheckKey && likesCheck.outdated);

  async function prepareSavedInputs(refreshWorkspace = false) {
    if (!client || !isCurrent(account) || savedInputsRead.current || selecting.current) return;
    const controller = new AbortController(); savedInputsRead.current = controller;
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    try {
      if (refreshWorkspace) {
        setSavedInputs({ status: "reading" });
        const result = await workspace.reload(false);
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
        // As part of this click, the engine writes every liked upload's missing note in one run.
        ...(engineOn ? { requestStyleNotes: async (referenceIds: readonly string[]) => {
          if (!await logoEngine.start(LOGO_ENGINE_KINDS.styleNote, { referenceIds }, { quiet: true })) throw new Error("Style notes not started");
        } } : {}),
        wait: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
          const abort = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
          signal.addEventListener("abort", abort, { once: true });
        }),
      });
      if (current() && result.status !== "obsolete") {
        if (result.status === "prepared") preparedInputsKey.current = JSON.stringify(result.request.expected);
        setSavedInputs(result);
      }
    } finally { if (savedInputsRead.current === controller) savedInputsRead.current = null; }
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
    if (!completedRefinement || !selectedLogo || completedRefinement.source.kind === "vector"
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
  }, [completedRefinement, projectId, selectedLogo, editing, workspace.pending, workspace.dirty, workspace.stagePayloads, saved, draft, isCurrent, account, memory, reloadWorkspace, selectCandidate]);

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
  const continueAction = activeBatch && !continueHidden ? workspace.stagePayloads?.concepts?.payload.selected && !selectionState.busy && !chosenLogoOutdated
    ? onContinue ? <button className={styles.primaryButton} type="button" onClick={() => { markDirectionsIntent(); onContinue(); }}>Continue</button>
      : <Link className={`${styles.primaryButton} ${stage.actionLink}`} href={`/brands/account/${projectId}/logo/directions`} onClick={markDirectionsIntent}>Continue</Link>
    : <button className={styles.primaryButton} type="button" disabled title={initialConceptReadState ? initialConceptReadMessage : chosenLogoOutdated ? "Choose a concept made with your current brand details and liked images" :"Select a logo and wait for it to save"}>Continue</button> : null;
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
        action={<LogoGenerationAction estimate={conceptEstimate} label="Explore six concepts" unavailable={savedInputsBusy ? "Preparing saved inputs…" : !canConcept ? drawingUnavailable : "Complete your saved logo inputs to continue."} />} />}
      {activeBatch && (changingTypes
        ? <LogoTypesQuestion value={draft?.brief.logoTypes ?? []} disabled={!canChangeTypes}
          onChange={draft && canChangeTypes ? types => workspace.setBriefDraft({ ...draft.brief, logoTypes: types }) : undefined}
          note="Your next concepts use these types. The concepts you already have stay available to choose."
          action={<button className={styles.secondaryButton} type="button" disabled={!draft?.brief.logoTypes.length} onClick={() => setChangingTypes(false)}>Done</button>} />
        : <LogoTypesSummary value={draft?.brief.logoTypes ?? []} disabled={!canChangeTypes} onChange={() => setChangingTypes(true)} />)}
    </div>
    {client && <LogoCandidateComparison client={client} account={account} projectId={projectId} sources={comparison} selected={selectedLogo}
      briefRevisionId={workspace.stagePayloads?.brief_references?.id} onRemove={source => setComparison(previous => previous.filter(item => logoCandidateKey(item) !== logoCandidateKey(source)))}
      onSelect={saved?.capabilities.save.status === "available" && !workspace.pending && !workspace.dirty && !draft?.conflict && editing ? source => void selectCandidate(source) : undefined} />}
    <LogoSavedInputsStatus state={savedInputs} projectId={projectId} onRefresh={() => void prepareSavedInputs(true)} />
    {recoveryTools}
    {workspace.error && <p className={styles.warning} role="alert">{workspace.error}</p>}
    {activeBatch && !chosenLogoOutdated && saved?.stages.brief_references && saved.stages.brief_references.id !== activeBatch.briefRevisionId && <p className={styles.note}>These concepts were made with your earlier logo choices. More concepts uses your current ones.</p>}
    {/* A change to the logo types alone keeps concepts current; brand details or liked images do not. */}
    {activeBatch && chosenLogoOutdated && <p className={styles.warning} role="status">Your brand details or liked images changed after this logo was made. To continue, choose a concept made with your current ones.</p>}
    {activeBatch && newerLikes && <div className={styles.likesUpdate} role="status">
      <p>You changed your likes after these concepts were made. Use them for your next concepts?{selectedLogo ? " Your chosen logo will then need to be chosen again from the new concepts before Creative direction." : ""}</p>
      <button type="button" className={styles.secondaryButton} disabled={!editing || savedInputsBusy} onClick={() => void prepareSavedInputs(true)}>Use my new likes</button>
    </div>}
    {activeBatch && selectionState.error && <p className={styles.warning} role="status">{selectionState.error}</p>}
    <LogoConceptGridView gallery status={activeBatch ? selectionState.busy ? "Saving your choice…" : initialConceptReadState ? initialConceptReadMessage : selectedLogo ? "Logo chosen" : "Pick the concept you like most" : undefined} versions={cardVersions} selectedVersion={selectedLogo} selectionAt={workspace.stagePayloads?.concepts?.createdAt} viewedVersions={viewedVersions}
      onViewVersion={(slotId, key, count) => setViewedVersions(previous => ({ ...previous, [slotId]: { key, count } }))}
      onSelectVersion={batchReady && saved?.capabilities.save.status === "available" && !workspace.pending && !workspace.dirty && !draft?.conflict && editing ? source => void selectCandidate(source) : undefined} filter={conceptFilter} comparison={comparison} onCompare={compareCandidate} batch={activeBatch} savedBatchUnavailable={savedBatchUnavailable} savedBatchLoading={savedBatchLoading}
      selected={selectedLogo?.kind === "concept" ? selectedLogo : null}
      onSelect={batchReady && saved?.capabilities.save.status === "available" && !workspace.pending && !workspace.dirty && editing ? source => void selectCandidate(source) : undefined}
      generation={canConcept ? { status: "available" } : { status: "unavailable", reason: drawingUnavailable }}
      refinement={canRefine ? { status: "available" } : { status: "unavailable", reason: drawingUnavailable }} drawingSlotIds={drawingSlotIds} undrawnSlotIds={undrawnSlotIds}
      renderPreview={client ? receipt => <LogoVerifiedPreview client={client} receipt={receipt} /> : undefined}
      generationActions={<>
        {!nameReadiness.supported && <p role="status">{nameReadiness.message}</p>}
        {activeBatch && <LogoGenerationAction variant="secondary" estimate={moreEstimate} label="More concepts" unavailable={canConcept ? "" : drawingUnavailable} />}
        {failedSlotIds.length > 0 && drawingSlotIds.size === 0 && <LogoGenerationAction variant="secondary" estimate={retryEstimate} label={`Retry ${failedSlotIds.length} failed concept${failedSlotIds.length === 1 ? "" : "s"}`} unavailable="" />}
        {engineRun && <button className={styles.secondaryButton} type="button" disabled={engineRun.cancelRequested} onClick={() => void logoEngine.cancel(engineRun.id)}>{engineRun.cancelRequested ? "Stopping…" : "Stop"}</button>}
      </>}
      onRequestRefine={batchReady && selectedLogo && canEstimate ? () => { refinementInput.current?.focus(); } : undefined} />
    {/* The refine box stays in one place below the concepts, so a draft survives the first set arriving. */}
    {conceptsComposer}
    {refinementHistoryState.error && <p role="status" className={styles.warning}>{refinementHistoryState.error}</p>}
    {refinementHistoryState.nextCursor && <button type="button" className={styles.secondaryButton} disabled={refinementHistoryState.loading} onClick={() => void refinementHistory?.loadMore()}>Load earlier versions</button>}
    {checkingRequest && <p className={styles.note} role="status">Checking the existing request…</p>}
  </div></div>;
}
