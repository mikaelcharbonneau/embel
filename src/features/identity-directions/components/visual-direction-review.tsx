"use client";
import { ContextDetails } from "@/components/ui/context-details";
import Link from "next/link";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { BrowserLocalDate } from "@/components/workspace/browser-local-date";
import { inspirationLabels } from "@/domain/inspiration";
import { visualDirectionReferences, type VisualDirectionGuidance } from "@/domain/visual-direction";
import { useVisualDirection } from "./use-visual-direction";
import styles from "./visual-direction-review.module.css";

const fields: { key: keyof VisualDirectionGuidance; label: string; placeholder: string }[] = [
  { key: "character", label: "Overall character", placeholder: "Describe the feeling and the details you want to avoid." },
  { key: "colors", label: "Color guidance", placeholder: "Describe useful color qualities, contrast and limits." },
  { key: "typography", label: "Typography guidance", placeholder: "Describe the tone, reading needs and hierarchy." },
  { key: "graphics", label: "Graphic rules", placeholder: "Describe shapes, layout, rhythm and supporting graphics." },
];
/** Can be mounted before logo approval; it never dispatches generation. */
export function VisualDirectionReview({ projectId, onSaved }: { projectId: string; onSaved?: () => Promise<void> | void }) {
  const { session } = useAccountSession();
  return session.status === "ready" ? <Review key={`${session.userId}:${session.generation}:${projectId}`} account={session} projectId={projectId} onSaved={onSaved} />
    : <section className={styles.panel} aria-label="Visual identity guidance"><p>Sign in to review this project’s visual direction.</p></section>;
}
function Review({ account, projectId, onSaved }: { account: VerifiedAccount; projectId: string; onSaved?: () => Promise<void> | void }) {
  const controller = useVisualDirection(account, projectId), { overview, guidance, draft } = controller;
  const references = overview ? visualDirectionReferences(overview.inspiration) : [];
  return <section className={styles.panel} id="visual-direction-review" aria-label="Visual identity guidance" aria-busy={controller.loading || controller.saving}>
    <header className={styles.header}><div><p className={styles.eyebrow}>Your visual direction</p><h3>Review the starting point</h3></div>
      <span className={styles.badge}>{overview?.current ? overview.stale ? "Needs review" : `Saved version ${overview.current.revision}` : "Not reviewed"}</span></header>
    <p>Review your saved inspiration and add guidance for the colors, typography and graphics around your approved logo.</p>
    <p className={styles.caption}>This guides identity directions after logo approval. Logo concepts use your saved logo brief and uploaded references.</p>
    {controller.loading && <p role="status">Loading saved visual direction…</p>}
    {controller.error && <p role="alert" className={styles.notice}>{controller.error}</p>}
    {controller.message && <p role="status" className={styles.notice}>{controller.message}</p>}
    {overview && <>
      {overview.stale && <p className={styles.notice}>Project details or saved inspiration changed since version {overview.current!.revision}. Review the current choices below before saving a new version. Earlier guidance and generated results are retained.</p>}
      {controller.blocked && <p className={styles.notice}>Save or resolve your pending project and Inspiration changes before reviewing this direction.</p>}
      {overview.inspiration.projectScope === "naming_only" && <p className={styles.notice}>Expand this project to a complete brand before saving visual guidance.</p>}
      <ContextDetails inline className={styles.references} title={<>{references.length} saved inspiration {references.length === 1 ? "reference" : "references"}</>}>{references.length ? <ul>{references.map(reference => <li key={reference.referenceId}>
          <strong>{reference.brand}</strong><span>{reference.creator}</span>
          <p>{[...(reference.ensemble ? ["Overall look"] : []), ...reference.elements.map(element => inspirationLabels[element])].join(" · ")}</p>
          <p>{reference.description}</p><a href={reference.sourceUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Original project</a>
        </li>)}</ul> : <p className={styles.caption}>No saved likes yet. You can browse Inspiration or write your own guidance.</p>}<p className={styles.caption}>Reference descriptions and attribution are retained as guidance. They do not grant artwork or font rights.</p></ContextDetails>
      <div className={styles.fields}>{fields.map(field => <label key={field.key}>{field.label}<textarea maxLength={1200} rows={3} value={guidance[field.key]} placeholder={field.placeholder}
        disabled={controller.saving || controller.loading || overview.inspiration.projectScope === "naming_only"}
        onChange={event => controller.edit({ ...guidance, [field.key]: event.target.value })} /></label>)}</div>
      {draft?.latest && <div className={styles.notice} role="status"><strong>The saved starting point changed</strong>
        <p>Your words are kept. Review the latest saved guidance before deciding.</p>
        <dl>{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{draft.latest!.current?.guidance[field.key] || "No written guidance"}</dd></div>)}</dl>
        <div className={styles.actions}><button type="button" onClick={controller.useLatest}>Use latest saved guidance</button><button type="button" onClick={controller.keepMine}>Keep my words for review</button></div></div>}
      <div className={styles.actions}>
        <button type="button" disabled={!controller.canSave} onClick={() => { void controller.save().then(saved => { if (saved) return onSaved?.(); }); }}>{controller.saving ? "Saving…" : "Review and save direction"}</button>
        <button type="button" disabled={controller.loading || controller.saving} onClick={() => void controller.refresh()}>{draft?.mustReload ? "Check saved direction" : "Refresh saved direction"}</button>
        {draft && !draft.mustReload && <button type="button" disabled={controller.saving} onClick={controller.discard}>Discard written edits</button>}
      </div>
      {overview.current && <p className={styles.caption}>Version {overview.current.revision} reviewed <BrowserLocalDate dateTime={overview.current.reviewedAt} />. Saving guidance does not approve a generated identity or start a provider request.</p>}
      {overview.history.length > 0 && <ContextDetails className={styles.history} title={<>Earlier reviewed guidance ({overview.history.length})</>}>{overview.history.map(version => <article key={version.id}><h4>Version {version.revision}</h4><p className={styles.caption}><BrowserLocalDate dateTime={version.reviewedAt} /> · {version.references.length} references · project revision {version.projectRevision}</p>
          <dl>{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{version.guidance[field.key] || "No written guidance"}</dd></div>)}</dl>
          <p>{version.references.map(reference => `${reference.brand}: ${[...(reference.ensemble ? ["Overall look"] : []), ...reference.elements.map(element => inspirationLabels[element])].join(", ")}`).join("; ")}</p>
          <button type="button" disabled={controller.saving || controller.loading || !!draft?.mustReload} onClick={() => controller.edit(version.guidance)}>Use these words as a draft</button></article>)}{overview.hasEarlierHistory && <p className={styles.caption}>The most recent 20 earlier versions are shown. Older versions remain retained.</p>}</ContextDetails>}
    </>}
    {!overview && !controller.loading && <button type="button" onClick={() => void controller.refresh()}>Retry connection</button>}
    <nav className={styles.links} aria-label="Visual direction navigation"><Link href={`/brands/account/${projectId}/inspiration`}>Browse Inspiration</Link><Link href={`/brands/account/${projectId}/logo`}>Review logo</Link><Link href={`/brands/account/${projectId}/logo/directions`}>Identity directions</Link></nav>
  </section>;
}
