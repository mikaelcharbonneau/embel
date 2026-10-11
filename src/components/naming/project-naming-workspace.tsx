"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { Icon } from "@/components/ui/icon";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { initialNamingPreferences, namingStrategyKey, type ProjectNameEntry, type TransformProjectNamesResponse } from "@/domain/project-naming";
import type { NameTransformInput } from "@/domain/naming";
import { NamingPreferencesPanel } from "./naming-preferences";
import { NamingResults, ProjectNameCard } from "./naming-results";
import { ProjectDock } from "@/components/workspace/project-workspace";
import { NamingInspect } from "./naming-inspect";
import { NamingScreening } from "./naming-screening";
import { initialNamingView, namingScrollTarget, useProjectNaming } from "./use-project-naming";
import { initialWorkshopControls, WorkshopControls } from "./workshop-controls";
import { useNamesStore } from "./use-names-store";

export function ProjectNamingWorkspace({ projectId }: { projectId: string }) {
  const { session } = useAccountSession();
  if (!z.uuid().safeParse(projectId).success) return <div className="page"><h1>Naming workspace not found</h1><Link href="/brands" className="text-link">Back to brands</Link></div>;
  if (session.status !== "ready") return <div className="page project-naming-page"><h1>Naming</h1><AccountStatus /><Link href="/brands" className="text-link">Back to brands</Link></div>;
  return <AccountProjectNaming key={`${session.userId}:${session.generation}:${projectId}`} projectId={projectId} account={session} />;
}

const missingLabels = { scope: "project scope", description: "description", reformulation: "activity and offering", competitors: "competitors", audience: "audience", personality: "personality", positioning: "positioning" };

function AccountProjectNaming({ projectId, account }: { projectId: string; account: VerifiedAccount }) {
  const router = useRouter();
  const { isCurrent } = useAccountSession();
  const naming = useProjectNaming({ account, projectId });
  const { overview, blocked, pending, readError, actionError } = naming;
  const [earlierChoice, setEarlierChoice] = useState<ProjectNameEntry | null>(null);
  const [acceptedEarlierFor, setAcceptedEarlierFor] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState(initialWorkshopControls);
  const [transformResult, setTransformResult] = useState<TransformProjectNamesResponse | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const strategyHref = `/brands/account/${projectId}`;
  if (!overview) return <div className="page project-naming-page"><header className="project-naming-header"><h1>Naming</h1><Link className="text-link" href={strategyHref}>Back to project</Link></header>{readError ? <div className="project-naming-notice" role="alert"><p>{readError}</p><button className="button secondary small" type="button" onClick={naming.refresh}>Check latest version</button></div> : <p className="project-naming-muted" role="status">Loading your account naming workspace…</p>}</div>;
  const { project } = overview;
  const view = overview.session?.viewState ?? initialNamingView;
  const conversationOpen = !overview.preferences || view.conversationOpen;
  const strategyKey = namingStrategyKey(project.context);
  const workshopEntry = overview.candidates.items.find(entry => entry.candidate.id === view.workshopCandidateId);
  const currentSelection = overview.currentSelection;
  const inspected = overview.candidates.items.find(entry => entry.candidate.id === inspectedId);
  const screening = !inspected && view.pane === "screening" && currentSelection;
  const originalDescription = project.context.description;
  const workshopOptions = overview.candidates.items.map((entry, index) => {
    const { candidate } = entry, origin = candidate.origin;
    const batch = origin.kind === "generated" ? overview.batches.items.find(item => item.batch.id === origin.batchId) : null;
    const source = origin.kind === "generated" ? `Batch ${batch?.batch.sequence ?? "saved"}` : origin.kind === "transform" ? `Workshop · ${origin.history.at(-1)?.input.kind ?? "variation"}` : "Copied name";
    return { id: candidate.id, value: candidate.value, label: `${candidate.value} · ${source} · ${index + 1}` };
  });

  function restoreResults() {
    requestAnimationFrame(() => {
      const id = namingScrollTarget(view.scrollCandidateId, overview!.candidates.items.map(entry => entry.candidate.id));
      const target = document.getElementById(id);
      target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "start" });
    });
  }
  function candidateAnchor() {
    const visible = Array.from(document.querySelectorAll<HTMLElement>(".project-naming-card[id]")).find(element => element.getBoundingClientRect().bottom > 0);
    return visible?.id.replace("project-name-", "") ?? view.scrollCandidateId;
  }
  async function closeConversation() {
    if (await naming.saveView({ conversationOpen: false })) restoreResults();
  }
  async function openConversation() {
    if (await naming.saveView({ conversationOpen: true, scrollCandidateId: candidateAnchor() })) requestAnimationFrame(() => { const heading = document.getElementById("project-naming-preferences-heading"); heading?.focus(); heading?.scrollIntoView({ block: "center" }); });
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
    const secondary = input.kind === "blend" ? overview!.candidates.items.find(entry => entry.candidate.id === secondaryCandidateId) : null;
    if (input.kind === "blend" && (!secondary || secondary.candidate.value !== input.right)) return;
    const result = await naming.transform({ parentCandidateId: workshopEntry.candidate.id, ...(secondary ? { secondaryCandidateId: secondary.candidate.id } : {}), input });
    if (result && isCurrent(account)) setTransformResult(result);
  }
  async function changeName() {
    if (await naming.saveView({ pane: "results" })) restoreResults();
  }

  if (project.scope === "visual_identity_only") return <div className="page project-naming-page"><header className="project-naming-header"><div><span className="project-naming-eyebrow">{project.title}</span><h1>Naming</h1></div></header><div className="project-naming-empty"><h2>This project focuses on visual identity</h2><p>Return to the project to expand its scope when you want to add Naming.</p><Link className="button secondary" href={strategyHref}>Back to project<Icon name="arrow" size={14} /></Link></div></div>;

  return <div className="page project-naming-page project-workbench"><div className="project-workbench-canvas">
    <header className="project-naming-header"><div><span className="project-naming-eyebrow">{project.title} · {project.scope === "naming_only" ? "Naming-only project" : "Complete brand"}</span><h1>{inspected ? "Inspect a name" : screening ? "Your selected name" : "Find a name that feels right"}</h1></div><div className="project-naming-header-actions"><Link className="text-link" href={strategyHref}>Back to Strategy<Icon name="arrow" size={14} /></Link>{currentSelection && !screening ? <button className="button secondary small" type="button" disabled={pending} onClick={() => void naming.saveView({ pane: "screening", scrollCandidateId: candidateAnchor() })}>View selected name</button> : null}</div></header>
    {blocked ? <div className="project-naming-notice" role="alert"><strong>{naming.workspace?.conflict ? "Resolve the saved-version conflict first" : "Save your Strategy changes first"}</strong><p>Your edits are preserved in this tab. Generation and name selection use the saved project.</p><Link className="text-link" href={strategyHref}>Return to Strategy<Icon name="arrow" size={13} /></Link></div> : null}
    {!overview.readiness.ready ? <div className="project-naming-notice"><strong>Strategy needs review</strong><p>Review {overview.readiness.missing.map(step => missingLabels[step]).join(", ")} before generating names for this brand. Earlier names stay available.</p><Link className="text-link" href={strategyHref}>Continue the Strategy conversation<Icon name="arrow" size={13} /></Link></div> : project.scope === "naming_only" && overview.readiness.missing.length ? <p className="project-naming-notice">Naming uses your saved description and preferences. Strategy not yet reviewed: {overview.readiness.missing.map(step => missingLabels[step]).join(", ")}.</p> : null}
    {readError || actionError ? <div className="project-naming-notice" role="alert"><p>{actionError ?? readError}</p><button className="button secondary small" type="button" disabled={pending} onClick={naming.refresh}>Check latest version</button></div> : null}
    {notice ? <p className="project-naming-notice" role="status">{notice}</p> : null}
    {earlierChoice ? <section className="project-naming-stale-choice" aria-label="Earlier strategy confirmation"><h2 id="project-naming-earlier-heading" tabIndex={-1}>Use {earlierChoice.candidate.value} from an earlier strategy?</h2><p>The current saved strategy differs from the context used for this name. Choosing it creates a new selection and keeps the original history.</p><label><input type="checkbox" checked={acceptedEarlierFor === strategyKey} disabled={pending} onChange={event => setAcceptedEarlierFor(event.target.checked ? strategyKey : null)} />I have reviewed this name against the current strategy and want to use it.</label><div className="project-naming-actions"><button className="button secondary small" type="button" disabled={pending} onClick={() => { setEarlierChoice(null); setAcceptedEarlierFor(null); setInspectedId(null); }}>Keep browsing</button><button className="button primary small" type="button" disabled={acceptedEarlierFor !== strategyKey || pending || blocked} onClick={() => void choose(earlierChoice, true)}>Use earlier-context name</button></div></section> : null}
    {inspected ? <NamingInspect entry={inspected} pending={pending} blocked={blocked} selected={currentSelection?.candidate.id === inspected.candidate.id} onBack={() => setInspectedId(null)} onUse={() => select(inspected)} onWorkshop={() => { setInspectedId(null); void openWorkshop(inspected); }} /> : screening ? <NamingScreening name={currentSelection.candidate.value} earlierContext={currentSelection.candidate.strategyKey !== strategyKey} pending={pending} onChangeName={() => void changeName()} /> : view.pane === "workshop" ? <section aria-label="Project naming workshop"><div className="project-naming-section-heading"><h2 id="project-naming-workshop-heading" tabIndex={-1}>Workshop</h2><button className="text-link" type="button" disabled={pending} onClick={() => void changeName()}>Back to names<Icon name="arrow" size={13} /></button></div>{workshopEntry ? <div className="project-naming-workshop"><WorkshopControls key={workshopEntry.candidate.id} seed={workshopEntry.candidate.value} value={workshop} onChange={setWorkshop} onRun={(input, secondaryCandidateId) => void runTransform(input, secondaryCandidateId)} disabled={pending || blocked} secondaryOptions={workshopOptions} /><div>{transformResult ? <p className="project-naming-notice" role="status">{transformResult.entries.length} workshop results saved. {transformResult.transform.notes.join(" ")}</p> : <p className="project-naming-muted">Explore a variation of this project name. Every run keeps its parent and transformation history.</p>}<div className="project-naming-grid">{(transformResult?.entries ?? overview.candidates.items.filter(entry => entry.candidate.origin.kind === "transform" && entry.candidate.origin.parentCandidateId === workshopEntry.candidate.id)).map(entry => {
        const currentEntry = overview.candidates.items.find(candidate => candidate.candidate.id === entry.candidate.id) ?? entry;
        return <ProjectNameCard key={entry.candidate.id} entry={currentEntry} selected={currentSelection?.candidate.id === entry.candidate.id} earlierContext={entry.candidate.strategyKey !== strategyKey} pending={pending} blockSelection={blocked} onFavorite={() => void naming.retain(currentEntry, "favorite")} onSave={() => void naming.retain(currentEntry, "saved")} onSelect={() => select(currentEntry)} onWorkshop={() => void openWorkshop(currentEntry)} />;
      })}</div></div></div> : <div className="project-naming-empty"><h3>Choose a name to transform</h3><p>The saved seed is outside the loaded list. Return to names and choose a project candidate.</p><button className="button secondary small" type="button" disabled={pending} onClick={() => void naming.saveView({ pane: "results", filter: "all", query: "", visibleBatchId: null })}>View project names</button></div>}</section> : overview.preferences || overview.candidates.items.length ? <NamingResults key={`${view.filter}:${view.query}:${view.visibleBatchId ?? "all"}`} overview={overview} view={view} pending={pending} blocked={blocked} readFailed={Boolean(readError)} listStatus={naming.listStatus} strategyKey={strategyKey} onView={patch => void naming.saveView(patch)} onModify={() => void openConversation()} onEnqueue={() => void naming.enqueue()} onCancel={job => void naming.cancel(job)} onRetain={(entry, field) => void naming.retain(entry, field)} onSelect={select} onInspect={entry => setInspectedId(entry.candidate.id)} onWorkshop={entry => void openWorkshop(entry)} onLoadMore={() => void naming.loadMore()} onLoadMoreBatches={() => void naming.loadMoreBatches()} /> : null}
    {!screening ? <LocalNameImport disabled={pending || blocked} onImport={async entry => { const saved = await naming.importLocal({ source: entry.source, capturedContext: entry.context }); if (saved && isCurrent(account)) setNotice(`Copied ${entry.source.value} into this project. Use this name is a separate selection; your browser original is unchanged.`); return saved; }} /> : null}
    {screening && project.scope === "complete_brand" ? <div className="project-naming-next">
      {pending || blocked || readError ? <button className="button secondary small" type="button" disabled>Continue to Identity</button> : <Link className="button secondary small" href={`/brands/account/${projectId}/identity`}>Continue to Identity<Icon name="arrow" size={14} /></Link>}
      <p className="project-naming-muted">Explore visual references with your saved name and brand context.</p>
    </div> : null}
    {project.scope === "naming_only" ? <div className="project-naming-next"><button className="button secondary small" type="button" disabled={pending || blocked} onClick={() => void naming.expand().then(expanded => { if (expanded && isCurrent(account)) router.push(strategyHref); })}>Expand to complete brand<Icon name="arrow" size={14} /></button><p className="project-naming-muted">Keep this brief, name history and current selection, then continue your Strategy conversation.</p></div> : null}
    {overview.preferences ? <button className="project-naming-chat-toggle" type="button" aria-label={conversationOpen ? "Close naming conversation" : "Reopen naming conversation"} aria-expanded={conversationOpen} disabled={pending} onClick={() => void (conversationOpen ? closeConversation() : openConversation())}><svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 11.5a8 8 0 0 1-8 8H4v-5a8 8 0 1 1 16-3Z" /><path d="M8 10h8M8 14h5" /></svg><span>{conversationOpen ? "Close conversation" : "Conversation"}</span></button> : null}
  </div><ProjectDock title="Naming" context={<p>{project.title} · saved strategy v{project.current_revision}</p>}>
    {conversationOpen && overview.readiness.ready ? <section className="project-naming-conversation" aria-label="Naming conversation">
      <div className="project-naming-context"><span>Saved project context · version {project.current_revision}</span><p>{originalDescription}</p><details><summary>Strategy carried into Naming</summary><dl><div><dt>Offering</dt><dd>{project.context.offering || "Not specified"}</dd></div><div><dt>Audience</dt><dd>{project.context.audienceSegments.filter(segment => segment.selected).map(segment => segment.label).join(", ") || project.context.knownAudience || "Not specified"}</dd></div><div><dt>Positioning</dt><dd>{project.context.positioning || "Not specified"}</dd></div><div><dt>Existing name</dt><dd>{project.context.selectedName || project.context.intake.suppliedName || "None selected"}</dd></div></dl><Link className="text-link" href={strategyHref}>Open the Strategy conversation</Link></details></div>
      <NamingPreferencesPanel initial={overview.preferences?.preferences ?? initialNamingPreferences(project.context)} savedVersion={overview.preferences?.version ?? 0} pending={pending} blocked={blocked} onSave={naming.savePreferences} onClose={() => void closeConversation()} />
    </section> : null}
    {!conversationOpen && overview.preferences ? <button className="button secondary small" type="button" onClick={() => void openConversation()}>Modify filters</button> : null}
  </ProjectDock></div>;
}

function LocalNameImport({ disabled, onImport }: { disabled: boolean; onImport: (entry: ReturnType<typeof useNamesStore>["data"]["candidates"][number]) => Promise<boolean> }) {
  const snapshot = useNamesStore();
  const [chosen, setChosen] = useState("");
  const entry = snapshot.data.candidates.find(candidate => candidate.source.id === chosen);
  return <details className="project-naming-import"><summary>Copy a name from this browser</summary><p className="project-naming-muted">Copy a local name and its captured context into this account project. Its browser history stays in place; choosing it as the project name is a separate action.</p>
    {snapshot.loaded && snapshot.data.candidates.length ? <><label><span className="sr-only">Browser name to copy</span><select value={chosen} disabled={disabled} onChange={event => setChosen(event.target.value)}><option value="">Choose a browser name</option>{snapshot.data.candidates.map(candidate => <option key={candidate.source.id} value={candidate.source.id}>{candidate.source.value} · {candidate.source.origin}</option>)}</select></label><button className="button secondary small" type="button" disabled={disabled || !entry} onClick={() => { if (entry) void onImport(entry).then(ok => { if (ok) setChosen(""); }); }}>Copy into this project</button></> : <p className="project-naming-muted">{snapshot.loaded ? "No names in this browser workspace." : "Loading browser names…"}</p>}
    {snapshot.storage !== "available" ? <p className="project-naming-muted">Browser storage needs attention. Your local recovery options are in <Link href="/names">Names → Browser library</Link>.</p> : null}
  </details>;
}
