"use client";

import { useState } from "react";
import { ProjectDock } from "@/components/workspace/project-workspace";
import { identityPreferencesSchema, initialIdentityPreferences } from "@/domain/project-identity";
import { BrowserLocalDate } from "@/components/workspace/browser-local-date";
import { identitySystemFreshness } from "./account-identity-client";
import { identityDraftChanged } from "./identity-draft-memory";
import { IdentityComponents } from "./identity-components";
import { IdentityHistory } from "./identity-history";
import { IdentityFreshnessNotice, IdentitySystemBoard, identitySourceLabel } from "./identity-system-board";
import { useProjectIdentity, type IdentityReferenceHint, type ProjectIdentityController } from "./use-project-identity";

function IdentityPreferences({ controller }: { controller: ProjectIdentityController }) {
  const { overview, preferenceValues: form, preferenceDraft: draft } = controller;
  if (!overview || !form) return null;
  const actual = overview.preferences?.preferences ?? initialIdentityPreferences(overview.project.context);
  const parsed = identityPreferencesSchema.safeParse({ version: 1, ...form });
  const matchesLatest = parsed.success && JSON.stringify(parsed.data) === JSON.stringify(actual);
  const conflict = Boolean(draft && draft.baselineRevision !== (overview.preferences?.revision ?? 0));
  return <details className="identity-preferences"><summary>Identity preferences{draft && identityDraftChanged(draft) ? " · unsaved edits" : ""}</summary>
    <form onSubmit={event => { event.preventDefault(); void controller.savePreferences(); }}><fieldset disabled={controller.pending || Boolean(draft?.pending)}><legend className="sr-only">Identity preferences</legend>
      <label>Creative locale<input aria-label="Identity creative locale" value={form.creativeLocale} maxLength={60} onChange={event => controller.setPreferenceValues({ ...form, creativeLocale: event.target.value })} /></label>
      <label>Direction notes<textarea aria-label="Identity direction notes" value={form.notes} maxLength={4000} onChange={event => controller.setPreferenceValues({ ...form, notes: event.target.value })} /></label>
      <label>Avoidance notes<textarea aria-label="Identity avoidance notes" value={form.avoidanceNotes} maxLength={4000} onChange={event => controller.setPreferenceValues({ ...form, avoidanceNotes: event.target.value })} /></label>
    </fieldset>
    {draft?.pending && <div className="identity-recovery" role="status"><p>{controller.pending ? "Saving Identity preferences…" : controller.preferenceRebaseReady && matchesLatest ? "The latest saved preferences match your draft. The original save could not be confirmed." : "The original preference save could not be confirmed. Check the latest before another save."}</p>
      <button type="button" className="text-link" disabled={controller.pending || controller.loading} onClick={() => { void controller.refresh(); }}>Check latest preferences</button>
    </div>}
    {(conflict || draft?.pending) && <div className="identity-recovery"><p>Saved preferences and this draft are kept separately.</p><button type="button" className="identity-secondary-button" disabled={controller.pending || controller.loading || !controller.preferenceRebaseReady} onClick={controller.keepPreferencesAgainstLatest}>Keep edits against latest</button></div>}
    <div className="identity-actions"><button type="submit" className="identity-primary-button" disabled={controller.pending || controller.loading || !controller.checked || !draft || !identityDraftChanged(draft) || Boolean(draft.pending) || conflict}>Save Identity preferences</button>
      <button type="button" className="text-link" disabled={controller.pending || !draft} onClick={controller.discardPreference}>{draft?.pending ? "Discard preference recovery" : "Discard preference edits"}</button></div>
    </form>
  </details>;
}
export function ProjectIdentityWorkspace({ projectId, referenceState }: { projectId: string; referenceState?: IdentityReferenceHint }) {
  const controller = useProjectIdentity(projectId, referenceState);
  const { overview, client, system } = controller;
  const [acknowledgment, setAcknowledgment] = useState<string | null>(null);
  if (!controller.verified || !client?.current()) return null;
  const acknowledgmentKey = `${controller.fence}:${system?.id ?? ""}:${controller.referencesPending}:${controller.preferencesDirty}:${controller.strategyDirty}`;
  if (acknowledgment !== null && acknowledgment !== acknowledgmentKey) setAcknowledgment(null);
  const freshness = system && overview ? identitySystemFreshness(system, overview) : null;
  const stale = freshness?.status === "stale";
  const acknowledged = !stale || acknowledgment === acknowledgmentKey;
  return <section className="project-identity project-workbench project-systems-workspace" aria-labelledby="project-identity-title"><div className="project-workbench-canvas"><div className="identity-section-heading"><div><h2 id="project-identity-title" tabIndex={-1}>Identity systems</h2><p>Saved choices, components and version history</p></div>
    <button type="button" className="text-link" disabled={controller.loading || controller.pending} onClick={() => { void controller.refresh(); }}>{controller.loading ? "Checking saved systems…" : "Check latest"}</button></div>
    <p className="identity-generation-gate">New system generation is unavailable.</p>
    {controller.error && <p className="identity-notice identity-error" role="alert">{controller.error}</p>}
    {controller.notice && <p className="identity-notice" role="status">{controller.notice}</p>}
    {!overview ? <p className="identity-empty" role="status">{controller.loading ? "Loading saved Identity systems…" : "Saved Identity systems are unavailable."}</p> : <>
      {controller.savesUnavailable && <p className="identity-notice identity-save-gate">Choosing a system and saving manual edits are unavailable right now.</p>}
      {controller.strategyDirty && <p className="identity-notice">Save or resolve your Strategy edits before choosing or refining a system.</p>}
      {controller.preferencesDirty && <p className="identity-notice">Save or discard your Identity preference edits before choosing or refining a system.</p>}
      {controller.selectionUncertain && <p className="identity-notice">The choice could not be confirmed. Check the latest before choosing or refining again.</p>}
      {controller.referencesPending && <p className="identity-notice">Reference choices are being checked. Choosing and refining will resume after the saved inputs are verified.</p>}
      {overview.currentBasis.status === "unavailable" && <IdentityFreshnessNotice freshness={overview.currentBasis} />}
      {controller.retained.some(draft => draft.kind === "component" && identityDraftChanged(draft)) && <div className="identity-recovery"><p>Component edits are retained in this tab.</p><div className="identity-actions">{controller.retained.filter(draft => draft.kind === "component" && identityDraftChanged(draft)).map(draft => draft.kind === "component" && <button type="button" className="text-link" key={`${draft.baseSystemVersionId}:${draft.component}`} disabled={controller.pending || controller.detailLoading} onClick={() => { void controller.viewSystem(draft.baseSystemVersionId); }}>Resume {draft.component} edit</button>)}</div></div>}
      {controller.detailLoading && <p role="status">Loading the exact saved system…</p>}
      {system && freshness && !controller.detailLoading && <section className="identity-system-detail" aria-labelledby="identity-detail-title"><div className="identity-section-heading"><div><h3 id="identity-detail-title">{system.input.basis.name}</h3><p>{identitySourceLabel(system.source)} · <BrowserLocalDate dateTime={system.createdAt} /></p></div>
        {overview.currentSelection?.system.id === system.id && <span className="identity-badge">Current choice</span>}</div>
        <IdentityFreshnessNotice freshness={freshness} /><IdentitySystemBoard board={system.board} name={system.input.basis.name} client={client} />
        {stale && <label className="identity-acknowledgment"><input type="checkbox" checked={acknowledgment === acknowledgmentKey} disabled={controller.pending || controller.loading || controller.referencesPending} onChange={event => setAcknowledgment(event.target.checked ? acknowledgmentKey : null)} />I understand this system uses earlier saved inputs.</label>}
        <div className="identity-actions"><button type="button" className="identity-primary-button" disabled={controller.blocked || !acknowledged || overview.currentSelection?.system.id === system.id} onClick={() => { void controller.chooseSystem(stale && acknowledged); }}>{overview.currentSelection?.system.id === system.id ? "Current Identity choice" : overview.currentSelection ? "Restore as current" : "Use this system"}</button></div>
        <IdentityComponents controller={controller} acknowledged={acknowledged} />
      </section>}
      <IdentityHistory items={controller.items} currentSystemId={overview.currentSelection?.system.id ?? null} viewedSystemId={system?.id ?? null} client={client} pending={controller.pending || controller.detailLoading} hasMore={Boolean(controller.nextCursor)} loadingMore={controller.loadingMore} onView={id => { void controller.viewSystem(id); }} onMore={() => { void controller.loadMore(); }} />
    </>}
  </div><ProjectDock title="Saved identity" context={<p>{system?.input.basis.name || "No system selected"}</p>}><IdentityPreferences controller={controller} /></ProjectDock></section>;
}
