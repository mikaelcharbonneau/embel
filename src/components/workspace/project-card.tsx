"use client";

import Link from "next/link";
import { type ReactNode, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icon";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { needsStrategyRecovery } from "./account-draft-memory";
import { projectStrategyHref } from "@/domain/project-handoff";
import type { LifecycleProject } from "./project-deletion-client";
import { scopeLabel } from "./local-drafts";
import { useProjectCardPreview } from "./use-project-card-preview";
import styles from "./project-card.module.css";

/** Home and Projects share the selected brand name and saved logo preview. */
export function ProjectCard({ project, account, headingLevel = 2, date, actions, deletionStatus, compact = false }: {
  project: LifecycleProject; account: VerifiedAccount; headingLevel?: 2 | 3; date: string; actions: ReactNode; deletionStatus?: ReactNode;
  /** Home: name and date on one line, then the next step. */
  compact?: boolean;
}) {
  const deleted = project.deletion_state !== "active";
  const owned = project.owner_id === account.userId;
  const { drafts } = useAccountSession();
  const recovering = useSyncExternalStore(drafts.subscribe, () => {
    const draft = drafts.get(project.id);
    return draft?.ownerId === account.userId && draft.generation === account.generation && needsStrategyRecovery(draft);
  }, () => false);
  const { target, current, preview, rejectImage } = useProjectCardPreview(account, project.id, project.current_revision, owned && !deleted, project.scope !== "naming_only");
  if (!current || !owned) return null;
  const title = preview?.selectedName || project.title;
  const action = recovering ? { label: "Resume Strategy edits", href: projectStrategyHref(project.id) }
    : preview?.action ?? { label: "Open project", href: `/brands/account/${project.id}` };
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const content = <>
    <div className={styles.preview} ref={target} data-project-preview={preview?.url ? "selected-logo" : "placeholder"}>
      {preview?.url
        // eslint-disable-next-line @next/next/no-img-element -- owner/hash-verified private object URL; no optimizer.
        ? <img src={preview.url} alt={`Saved selected logo${preview.name ? ` for ${preview.name}` : ""}`} onError={() => rejectImage(preview.url!)} />
        : <div className={styles.placeholder}><Icon name="brands" size={24} /><span>{deleted ? "Saved project" : project.scope === "naming_only" ? "Naming project" : preview?.status === "unavailable" ? "Preview unavailable" : preview?.status === "ready" ? "No logo selected" : "Saved project"}</span></div>}
    </div>
    {compact && !deleted ? <div className={`${styles.details} ${styles.compactDetails}`}>
      <div className={styles.compactRow}><Heading className={styles.compactTitle} title={title}>{title}</Heading><span className={styles.compactDate} title={project.created_at}>{date}</span></div>
      <span className={styles.next}>{action.label}</span>
    </div> : <div className={styles.details}>
      <Heading className={styles.title} title={title}>{title}</Heading>
      <div className={styles.metadata}><span>{scopeLabel(project.scope)}</span>{!deleted && <span title={project.created_at}>{date}</span>}</div>
      {deleted ? <>{deletionStatus}<div className={`${styles.deletedFooter} project-footer`}><span title={project.deletion_requested_at ?? project.deleted_at ?? project.created_at}>{date}</span>{actions}</div></> : <span className={styles.footer}>{action.label}<Icon name="arrow" size={16} /></span>}
    </div>}
  </>;
  return <article className={`${styles.card} ${headingLevel === 3 ? "home-brand-card" : "project-card"}${deleted ? " project-card--deleted" : ""}`} data-storage="account" data-project-id={project.id}>
    {deleted ? <div className={styles.deletedContent}>{content}</div> : <><Link className={styles.link} href={action.href} aria-label={`${action.label} · ${title}`}>{content}</Link>{actions}</>}
  </article>;
}
