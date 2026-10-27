"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { Icon } from "@/components/ui/icon";
import styles from "./naming-chat.module.css";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { namingStrategyKey, type ProjectNameEntry, type TransformProjectNamesResponse } from "@/domain/project-naming";
import { getProjectHandoff } from "@/domain/project-handoff";
import type { NameTransformInput } from "@/domain/naming";
import { NamingApproachWidgets } from "./naming-approach-widgets";
import { useNamingFeed } from "./use-naming-feed";
import { NamingFeedResults, NamingFeedTail } from "./naming-feed-results";
import { NamingResults, ProjectNameCard } from "./naming-results";
import { NamingInspect } from "./naming-inspect";
import { NamingScreening } from "./naming-screening";
import { ProjectScreeningEvidence } from "./project-screening-evidence";
import { initialNamingView, namingScrollTarget, useProjectNaming } from "./use-project-naming";
import { useCustomProjectNames } from "./use-custom-project-names";
import { initialWorkshopControls, WorkshopControls } from "./workshop-controls";
import { nameValueSchema, type NamingSource } from "@/domain/naming";

export function ProjectNamingWorkspace({ projectId, conversationHistory }: { projectId: string; conversationHistory?: ReactNode }) {
  const { session } = useAccountSession();
  if (!z.uuid().safeParse(projectId).success) return <div className="page"><h1>Naming workspace not found</h1><Link href="/brands" className="text-link">Back to brands</Link></div>;
  if (session.status !== "ready") return <div className="page project-naming-page"><h1>Naming</h1><AccountStatus /><Link href="/brands" className="text-link">Back to brands</Link></div>;
  return <AccountProjectNaming key={`${session.userId}:${session.generation}:${projectId}`} projectId={projectId} account={session} conversationHistory={conversationHistory} />;
}

const missingLabels = { scope: "project scope", description: "description", reformulation: "activity and offering", competitors: "competitors", audience: "audience", personality: "personality", positioning: "positioning" };

function AccountProjectNaming({ projectId, account, conversationHistory }: { projectId: string; account: VerifiedAccount; conversationHistory?: ReactNode }) {
  const router = useRouter();
  const { isCurrent } = useAccountSession();
  const naming = useProjectNaming({ account, projectId });
  const custom = useCustomProjectNames(account, projectId);
  const { overview, blocked, pending, readError, actionError } = naming;
  const [earlierChoice, setEarlierChoice] = useState<ProjectNameEntry | null>(null);
  const [acceptedEarlierFor, setAcceptedEarlierFor] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState(initialWorkshopControls);
  const [transformResult, setTransformResult] = useState<TransformProjectNamesResponse | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const returnFromInspection = useRef<string | null>(null);
  useLayoutEffect(() => {
    const candidateId = returnFromInspection.current;
    if (inspectedId || !candidateId) return;
    returnFromInspection.current = null;
    if (!isCurrent(account)) return;
    const card = document.getElementById(`project-name-${candidateId}`);
    const target = card?.querySelector<HTMLElement>("h3 button, .project-naming-actions button") ?? card
      ?? document.querySelector<HTMLElement>("[data-naming-results-scroll]");
    target?.focus({ preventScroll: true });
  }, [inspectedId, account, isCurrent]);
  function closeInspection() {
    returnFromInspection.current = inspectedId;
    setInspectedId(null);
  }
  const [conversationExpanded, setConversationExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [explorationStarted, setExplorationStarted] = useState(false);
  const manualNameDraft = useManualProjectNameDraft();
  const feed = useNamingFeed({ account, projectId, projectRevision: overview?.project.current_revision, enabled: Boolean(overview?.readiness.ready && !blocked && !readError), view: { ...(overview?.session?.viewState ?? initialNamingView), inspecting: Boolean(inspectedId), historyOpen, explorationHidden: false } });
  const { eligibleView, start: startFeed } = feed;
  const generationUnavailable = feed.state?.feed?.availability.status === "unavailable";
  const continuation = useRef<{ started: boolean; resolve: (started: boolean) => void } | null>(null);
  const [continueVersion, setContinueVersion] = useState(0);
  useEffect(() => {
    const request = continuation.current;
    if (!request || request.started) return;
    request.started = true;
    // Only the explicit final answer or recovery action queues this request. The saved view and
    // the feed's layout-effect eligibility must both be committed first.
    if (!eligibleView || !isCurrent(account)) { continuation.current = null; request.resolve(false); return; }
    void startFeed().then(request.resolve).finally(() => { if (continuation.current === request) continuation.current = null; });
  }, [continueVersion, eligibleView, startFeed, account, isCurrent]);
  useEffect(() => () => { continuation.current?.resolve(false); continuation.current = null; }, []);
  const strategyHref = `/brands/account/${projectId}`;
  if (!overview) return <div className={`page project-naming-page ${styles.loading}`}><header className="project-naming-header"><h1>Naming</h1><Link className="text-link" href={strategyHref}>Back to project</Link></header>{readError ? <div className="project-naming-notice" role="alert"><p>{readError}</p><button className="button secondary small" type="button" onClick={naming.refresh}>Check latest version</button></div> : <p className="project-naming-muted" role="status">Loading your account naming workspace…</p>}</div>;
  const { project } = overview;
  const view = overview.session?.viewState ?? initialNamingView;
  const exploring = explorationStarted || Boolean(feed.entries.length || overview.candidates.items.length || feed.state?.feed?.activeRun || feed.state?.pending);
  // Admission and partial publications are not the completed initial set.
  // Existing completed libraries stay accessible during later generation/review.
  const readyCount = feed.state?.feed?.activeRun?.fulfillment?.acceptedCount ?? 0;
  const activeRun = feed.state?.feed?.activeRun;
  const generationPending = Boolean(feed.state?.pending || activeRun && ["queued", "running", "cancel_requested"].includes(activeRun.state));
  const existingLibrary = custom.items.length > 0 || feed.entries.some(row => row.runId === null) || overview.candidates.items.some(entry => entry.candidate.origin.kind !== "generated");
  const showCanvas = historyOpen || existingLibrary || feed.entries.length >= 100 || overview.candidates.items.length >= 100 || (feed.state?.feed?.progressive?.publishedCount ?? 0) >= 100 || readyCount >= 100 || Boolean(overview.currentSelection) || overview.preferences?.preferences.version === 1;
  const lookup = new Map(overview.candidates.items.map(entry => [entry.candidate.id, entry]));
  for (const entry of custom.items) { const old = lookup.get(entry.candidate.id); if (!old || old.retention.revision <= entry.retention.revision) lookup.set(entry.candidate.id, entry); }
  for (const row of feed.entries) { const old = lookup.get(row.entry.candidate.id); if (!old || old.retention.revision <= row.entry.retention.revision) lookup.set(row.entry.candidate.id, row.entry); }
  const candidates = [...lookup.values()];
  const strategyKey = namingStrategyKey(project.context);
  const workshopEntry = candidates.find(entry => entry.candidate.id === view.workshopCandidateId);
  const currentSelection = overview.currentSelection;
  const inspected = candidates.find(entry => entry.candidate.id === inspectedId);
  const screening = !inspected && view.pane === "screening" && currentSelection;
  const workshopOptions = candidates.map((entry, index) => {
    const { candidate } = entry, origin = candidate.origin;
    const batch = origin.kind === "generated" ? overview.batches.items.find(item => item.batch.id === origin.batchId) : null;
    const source = origin.kind === "generated" ? `Batch ${batch?.batch.sequence ?? "saved"}` : origin.kind === "transform" ? `Workshop · ${origin.history.at(-1)?.input.kind ?? "variation"}` : "User-supplied name";
    return { id: candidate.id, value: candidate.value, label: `${candidate.value} · ${source} · ${index + 1}` };
  });

  function restoreResults() {
    requestAnimationFrame(() => {
      const id = namingScrollTarget(view.scrollCandidateId, candidates.map(entry => entry.candidate.id));
      const target = document.getElementById(id);
      target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "start" });
    });
  }
  function candidateAnchor() {
    const top = Math.max(0, document.querySelector<HTMLElement>("[data-naming-results-scroll]")?.getBoundingClientRect().top ?? 0);
    const visible = Array.from(document.querySelectorAll<HTMLElement>(".project-naming-card[id]")).find(element => element.getBoundingClientRect().bottom > top);
    return visible?.id.replace("project-name-", "") ?? view.scrollCandidateId;
  }
  async function closeConversation(restore = true) {
    setConversationExpanded(false);
    if (overview!.session) await naming.saveView({ conversationOpen: false });
    if (restore) restoreResults();
    else requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-naming-results-scroll]")?.scrollTo?.({ top: 0 }));
  }
  async function openConversation() {
    setConversationExpanded(true);
    if (await naming.saveView({ conversationOpen: true, scrollCandidateId: candidateAnchor() })) requestAnimationFrame(() => { const heading = document.getElementById("project-naming-preferences-heading"); heading?.focus(); heading?.scrollIntoView({ block: "center" }); });
  }
  async function continueExploration() {
    if (!isCurrent(account) || continuation.current) return false;
    if ((view.pane !== "results" || view.filter !== "all" || view.query || view.visibleBatchId)
      && !await naming.saveView({ pane: "results", filter: "all", query: "", visibleBatchId: null })) return false;
    if (!isCurrent(account)) return false;
    setHistoryOpen(false); setInspectedId(null); naming.refresh();
    const started = await new Promise<boolean>(resolve => { continuation.current = { started: false, resolve }; setContinueVersion(version => version + 1); });
    if (started && isCurrent(account)) { setExplorationStarted(true); if (showCanvas) await closeConversation(exploring); }
    return started;
  }
  async function choose(entry: ProjectNameEntry, acknowledged: boolean) {
    if (!isCurrent(account) || blocked) return;
    if (!await naming.saveView({ scrollCandidateId: entry.candidate.id })) return;
    if (!await naming.select(entry, acknowledged)) return;
    setEarlierChoice(null); setAcceptedEarlierFor(null); setInspectedId(null);
    if (await naming.saveView({ pane: "screening", conversationOpen: false })) requestAnimationFrame(() => { const heading = document.getElementById("project-naming-screening-heading"); heading?.focus(); heading?.scrollIntoView({ block: "center" }); });
  }
  function select(entry: ProjectNameEntry) {
    if (entry.candidate.strategyKey !== strategyKey) { setEarlierChoice(entry); setAcceptedEarlierFor(null); requestAnimationFrame(() => document.getElementById("project-naming-earlier-heading")?.focus()); }
    else void choose(entry, false);
  }
  async function openWorkshop(entry: ProjectNameEntry) {
    setWorkshop(initialWorkshopControls()); setTransformResult(null);
    if (await naming.saveView({ pane: "workshop", workshopCandidateId: entry.candidate.id, scrollCandidateId: entry.candidate.id })) requestAnimationFrame(() => document.getElementById("project-naming-workshop-heading")?.focus());
  }
  async function runTransform(input: NameTransformInput, secondaryCandidateId?: string) {
    if (!workshopEntry) return;
    const secondary = input.kind === "blend" ? candidates.find(entry => entry.candidate.id === secondaryCandidateId) : null;
    if (input.kind === "blend" && (!secondary || secondary.candidate.value !== input.right)) return;
    const result = await naming.transform({ parentCandidateId: workshopEntry.candidate.id, ...(secondary ? { secondaryCandidateId: secondary.candidate.id } : {}), input });
    if (result && isCurrent(account)) setTransformResult(result);
  }
  function retain(entry: ProjectNameEntry, field: "favorite" | "saved") {
    return naming.retain(entry, field, custom.acknowledge);
  }
  async function changeName() {
    if (await naming.saveView({ pane: "results" })) restoreResults();
  }
  async function importManualName(source: NamingSource) {
    const saved = await naming.importLocal({ source, capturedContext: project.context }, custom.acknowledge);
    if (saved) await custom.refresh();
    return saved;
  }

  if (project.scope === "visual_identity_only") return <div className="page project-naming-page"><header className="project-naming-header"><div><span className="project-naming-eyebrow">{project.title}</span><h1>Naming</h1></div></header><div className="project-naming-empty"><h2>This project focuses on visual identity</h2><p>Return to the project to expand its scope when you want to add Naming.</p><Link className="button secondary" href={strategyHref}>Back to project<Icon name="arrow" size={14} /></Link></div></div>;

  const manualName = !screening && !inspected && (!showCanvas || view.pane === "results") ? <ManualProjectName disabled={pending || blocked} onAdd={importManualName} draft={manualNameDraft} /> : null;

  return <div className={`page project-naming-page project-workbench ${styles.workspace} ${showCanvas ? styles.exploring : styles.chatFirst}`} data-naming-layout={showCanvas ? "results" : "chat"} data-chat-open={conversationExpanded}>

    {!showCanvas && (readError || actionError) && <div className="project-naming-notice" role="alert"><p>{actionError ?? readError}</p><button type="button" className="button secondary small" disabled={pending} onClick={naming.refresh}>Check latest version</button></div>}
    <aside className={styles.chatPanel} aria-label="Naming conversation"><header className={styles.chatHeader} hidden><strong>Chat</strong><Link href={strategyHref} className="text-link">Strategy<Icon name="arrow" size={13} /></Link></header>
      <h1 className={styles.openingTitle} hidden={showCanvas}>Find a name that feels right</h1>
      {!showCanvas && <div className={styles.compose}>{manualName}</div>}
      {overview.readiness.ready ? <NamingApproachWidgets conversationHistory={conversationHistory} compact={showCanvas} conversationOpen={conversationExpanded} onToggleConversation={() => void (conversationExpanded ? closeConversation(false) : openConversation())} memory={feed.memory} account={account} projectId={projectId} context={project.context} saved={overview.preferences} savedChat={view.namingChat} onSaveProgress={naming.saveChatProgress} blocked={blocked || Boolean(readError)} generationUnavailable={generationUnavailable} runtimeReady={!generationUnavailable && feed.state?.feed?.availability.status === "available" && feed.state?.status !== "blocked" && feed.state?.feed?.activeRun?.state !== "needs_reconciliation"} exploring={exploring} canSteer={feed.canExplore} onSteer={feed.steer} onCheckSaved={naming.refresh} onContinue={continueExploration} generationStatus={<div className="naming-generation-status" role="status"><NamingFeedTail feed={feed} blocked={blocked} onModify={() => void openConversation()} onReviewSaved={!showCanvas ? () => setHistoryOpen(true) : undefined} />{!showCanvas && generationPending && !generationUnavailable && <p>{Math.min(100, activeRun?.fulfillment?.acceptedCount ?? feed.entries.filter(row => row.runId === activeRun?.runId).length)} of 100 names saved. Your conversation stays here while exploration is active.</p>}</div>} /> : <p className={styles.chatUnavailable}>Review Strategy to continue the Naming conversation. Your saved names remain available.</p>}
    </aside>
    <div className={`project-workbench-canvas ${styles.canvas}`} hidden={!showCanvas} data-naming-results-scroll tabIndex={0} aria-label="Naming results workspace">
    <header className="project-naming-header"><div><span className="project-naming-eyebrow">{project.title} · {project.scope === "naming_only" ? "Naming-only project" : "Complete brand"}</span><h1>{inspected ? "Inspect a name" : screening ? "Your selected name" : "Find a name that feels right"}</h1></div><div className="project-naming-header-actions"><Link className="text-link" href={strategyHref}>Back to Strategy<Icon name="arrow" size={14} /></Link>{currentSelection && !screening ? <button className="button secondary small" type="button" disabled={pending} onClick={() => void naming.saveView({ pane: "screening", scrollCandidateId: candidateAnchor() })}>View selected name</button> : null}</div></header>
    {blocked ? <div className="project-naming-notice" role="alert"><strong>{naming.workspace?.conflict ? "Resolve the saved-version conflict first" : "Save your Strategy changes first"}</strong><p>Your edits are preserved in this tab. Generation and name selection use the saved project.</p><Link className="text-link" href={strategyHref}>Return to Strategy<Icon name="arrow" size={13} /></Link></div> : null}
    {!overview.readiness.ready ? <div className="project-naming-notice"><strong>Strategy needs review</strong><p>Review {overview.readiness.missing.map(step => missingLabels[step]).join(", ")} before generating names for this brand. Earlier names stay available.</p><Link className="text-link" href={getProjectHandoff(project).next.href}>Continue the Strategy conversation<Icon name="arrow" size={13} /></Link></div> : project.scope === "naming_only" && overview.readiness.missing.length ? <p className="project-naming-muted">Naming uses your saved description and preferences. Strategy not yet reviewed: {overview.readiness.missing.map(step => missingLabels[step]).join(", ")}.</p> : null}
    {readError || actionError ? <div className="project-naming-notice" role="alert"><p>{actionError ?? readError}</p><button className="button secondary small" type="button" disabled={pending} onClick={naming.refresh}>Check latest version</button></div> : null}
    {showCanvas && manualName}
    {!screening && !inspected && feed.eligibleView && candidates.some(entry => entry.candidate.origin.kind === "local_import" && !feed.entries.some(row => row.entry.candidate.id === entry.candidate.id)) && <section className={styles.customNames} aria-label="Your custom names"><h2>Your custom names</h2><div className="project-naming-grid">{candidates.filter(entry => entry.candidate.origin.kind === "local_import" && !feed.entries.some(row => row.entry.candidate.id === entry.candidate.id)).map(entry => <ProjectNameCard key={entry.candidate.id} compact entry={entry} selected={currentSelection?.candidate.id === entry.candidate.id} earlierContext={entry.candidate.strategyKey !== strategyKey} pending={pending} blockSelection={blocked} onFavorite={() => void retain(entry, "favorite")} onSave={() => void retain(entry, "saved")} onSelect={() => select(entry)} onInspect={() => setInspectedId(entry.candidate.id)} onWorkshop={() => void openWorkshop(entry)} />)}</div></section>}
    {!screening && !inspected && feed.eligibleView && (custom.error || custom.nextCursor) && <div className="project-naming-actions">{custom.error ? <><p role="alert">Your custom names could not be refreshed. Any names already saved are retained.</p><button className="button secondary small" type="button" onClick={() => void custom.refresh()}>Check custom names</button></> : <button className="button secondary small" type="button" disabled={custom.pending} onClick={() => void custom.loadMore()}>Load more custom names</button>}</div>}
    {earlierChoice ? <section className="project-naming-stale-choice" aria-label="Earlier strategy confirmation"><h2 id="project-naming-earlier-heading" tabIndex={-1}>Use {earlierChoice.candidate.value} from an earlier strategy?</h2><p>The current saved strategy differs from the context used for this name. Choosing it creates a new selection and keeps the original history.</p><label><input type="checkbox" checked={acceptedEarlierFor === strategyKey} disabled={pending} onChange={event => setAcceptedEarlierFor(event.target.checked ? strategyKey : null)} />I have reviewed this name against the current strategy and want to use it.</label><div className="project-naming-actions"><button className="button secondary small" type="button" disabled={pending} onClick={() => { setEarlierChoice(null); setAcceptedEarlierFor(null); setInspectedId(null); }}>Keep browsing</button><button className="button primary small" type="button" disabled={acceptedEarlierFor !== strategyKey || pending || blocked} onClick={() => void choose(earlierChoice, true)}>Use earlier-context name</button></div></section> : null}
    {historyOpen && !inspected && !screening && view.pane === "results" ? <button type="button" className="text-link naming-back-to-feed" onClick={() => { setHistoryOpen(false); void naming.saveView({ pane: "results", filter: "all", query: "", visibleBatchId: null }); }}>Back to exploration</button> : null}
    {inspected ? <NamingInspect claims={feed.entries.find(row => row.entry.candidate.id === inspected.candidate.id)?.publishedClaims} entry={inspected} pending={pending} blocked={blocked} selected={currentSelection?.candidate.id === inspected.candidate.id} onBack={closeInspection} onUse={() => select(inspected)} onWorkshop={() => { setInspectedId(null); void openWorkshop(inspected); }} onSave={() => void retain(inspected, "saved")} onFavorite={() => void retain(inspected, "favorite")} steeringSelected={feed.steeringDraft.candidateIds.includes(inspected.candidate.id)} steeringDisabled={blocked || Boolean(feed.state?.steering) || feed.steeringDraft.candidateIds.length >= 5 && !feed.steeringDraft.candidateIds.includes(inspected.candidate.id)} onSteering={feed.entries.some(row => row.entry.candidate.id === inspected.candidate.id) ? () => feed.updateSteeringDraft({ candidateIds: feed.steeringDraft.candidateIds.includes(inspected.candidate.id) ? feed.steeringDraft.candidateIds.filter(id => id !== inspected.candidate.id) : [...feed.steeringDraft.candidateIds, inspected.candidate.id] }) : undefined} /> : screening ? <><NamingScreening name={currentSelection.candidate.value} earlierContext={currentSelection.candidate.strategyKey !== strategyKey} pending={pending} onChangeName={() => void changeName()} /><ProjectScreeningEvidence key={`${currentSelection.selection.id}:${project.current_revision}`} projectId={projectId} selectionId={currentSelection.selection.id} projectRevision={project.current_revision} name={currentSelection.candidate.value} disabled={pending || blocked || Boolean(readError)} /></> : view.pane === "workshop" ? <section aria-label="Project naming workshop"><div className="project-naming-section-heading"><h2 id="project-naming-workshop-heading" tabIndex={-1}>Workshop</h2><button className="text-link" type="button" disabled={pending} onClick={() => void changeName()}>Back to names<Icon name="arrow" size={13} /></button></div>{workshopEntry ? <div className="project-naming-workshop"><WorkshopControls key={workshopEntry.candidate.id} seed={workshopEntry.candidate.value} value={workshop} onChange={setWorkshop} onRun={(input, secondaryCandidateId) => void runTransform(input, secondaryCandidateId)} disabled={pending || blocked} secondaryOptions={workshopOptions} /><div>{transformResult ? <p className="project-naming-notice" role="status">{transformResult.entries.length} workshop results saved. {transformResult.transform.notes.join(" ")}</p> : <p className="project-naming-muted">Explore a variation of this project name. Every run keeps its parent and transformation history.</p>}<div className="project-naming-grid">{(transformResult?.entries ?? overview.candidates.items.filter(entry => entry.candidate.origin.kind === "transform" && entry.candidate.origin.parentCandidateId === workshopEntry.candidate.id)).map(entry => {
        const currentEntry = candidates.find(candidate => candidate.candidate.id === entry.candidate.id) ?? entry;
        return <ProjectNameCard key={entry.candidate.id} entry={currentEntry} selected={currentSelection?.candidate.id === entry.candidate.id} earlierContext={entry.candidate.strategyKey !== strategyKey} pending={pending} blockSelection={blocked} onFavorite={() => void retain(currentEntry, "favorite")} onSave={() => void retain(currentEntry, "saved")} onSelect={() => select(currentEntry)} onWorkshop={() => void openWorkshop(currentEntry)} onInspect={() => setInspectedId(currentEntry.candidate.id)} compact />;
      })}</div></div></div> : <div className="project-naming-empty"><h3>Choose a name to transform</h3><p>The saved seed is outside the loaded list. Return to names and choose a project candidate.</p><button className="button secondary small" type="button" disabled={pending} onClick={() => void naming.saveView({ pane: "results", filter: "all", query: "", visibleBatchId: null })}>View project names</button></div>}</section> : feed.eligibleView ? <NamingFeedResults feed={feed} selectedId={currentSelection?.candidate.id} strategyKey={strategyKey} pending={pending} blocked={blocked || Boolean(readError)} onRetain={(entry, field) => void retain(entry, field)} onSelect={select} onInspect={entry => setInspectedId(entry.candidate.id)} onWorkshop={entry => void openWorkshop(entry)} onModify={() => void openConversation()} onHistory={() => setHistoryOpen(true)} /> : overview.session || overview.preferences || overview.candidates.items.length ? <NamingResults compact historyOnly={overview.preferences?.preferences.version === 2 || feed.record?.preferences?.saved?.preferences.version === 2 || Boolean(feed.record?.preferences?.dirty || feed.record?.preferences?.pending)} overview={overview} view={view} pending={pending} blocked={blocked} readFailed={Boolean(readError)} listStatus={naming.listStatus} strategyKey={strategyKey} onView={patch => void naming.saveView(patch).then(saved => { if (saved && patch.visibleBatchId) void naming.loadBatchDetail(patch.visibleBatchId); })} onModify={() => void openConversation()} onEnqueue={() => void naming.enqueue()} onCancel={job => void naming.cancel(job)} onRetain={(entry, field) => void retain(entry, field)} onSelect={select} onInspect={entry => setInspectedId(entry.candidate.id)} onWorkshop={entry => void openWorkshop(entry)} onLoadMore={() => void naming.loadMore()} onLoadMoreBatches={() => void naming.loadMoreBatches()} /> : null}

    {screening && project.scope === "complete_brand" ? <div className="project-naming-next">
      {pending || blocked || readError ? <button className="button secondary small" type="button" disabled>Continue to Inspiration</button> : <Link className="button secondary small" href={`/brands/account/${projectId}/inspiration`}>Continue to Inspiration<Icon name="arrow" size={14} /></Link>}
      <p className="project-naming-muted">Explore visual references, then continue to Logo. Your saved name and brand context stay with this project.</p>
    </div> : null}
    {project.scope === "naming_only" ? <div className="project-naming-next"><button className="button secondary small" type="button" disabled={pending || blocked} onClick={() => void naming.expand().then(expanded => { if (expanded && isCurrent(account)) router.push(strategyHref); })}>Expand to complete brand<Icon name="arrow" size={14} /></button><p className="project-naming-muted">Keep this brief, name history and current selection, then continue your Strategy conversation.</p></div> : null}
  </div></div>;
}

function useManualProjectNameDraft() {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<NamingSource | null>(null);
  const lockRef = useRef(false);
  return { value, setValue, saving, setSaving, error, setError, intent, setIntent, lockRef };
}

export function ManualProjectName({ disabled, onAdd, draft }: { disabled: boolean; onAdd: (source: NamingSource) => Promise<boolean>; draft?: ReturnType<typeof useManualProjectNameDraft> }) {
  const localDraft = useManualProjectNameDraft();
  const { value, setValue, saving, setSaving, error, setError, intent, setIntent, lockRef } = draft ?? localDraft;
  async function submit() {
    if (disabled || lockRef.current) return;
    const parsed = nameValueSchema.safeParse(value);
    if (!parsed.success) { setError("Enter a visible name of up to 160 characters."); return; }
    const source = intent ?? { id: crypto.randomUUID(), value: parsed.data, createdAt: new Date().toISOString(), origin: "manual", history: [] };
    setIntent(source); lockRef.current = true; setSaving(true); setError(null);
    try {
      if (await onAdd(source)) { setIntent(null); setValue(""); }
      else setError("This save could not be confirmed. Retry the same name to check it safely.");
    } catch { setError("This save could not be confirmed. Retry the same name to check it safely."); }
    finally { lockRef.current = false; setSaving(false); }
  }
  return <form className={styles.manualName} aria-label="Add your own name" onSubmit={event => { event.preventDefault(); void submit(); }}><label>Your own name<input value={value} maxLength={160} disabled={disabled || saving || Boolean(intent)} onChange={event => { setValue(event.target.value); setError(null); }} placeholder="Enter a name you have in mind" /></label><button className="button secondary small" type="submit" disabled={disabled || saving || !value.trim()}>{saving ? "Saving name…" : intent ? "Retry saving name" : "Add name"}</button>{error && <p role="alert">{error}</p>}</form>;
}
