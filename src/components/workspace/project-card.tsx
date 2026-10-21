"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import type { VerifiedAccount } from "./account-session";
import type { LifecycleProject } from "./project-deletion-client";
import { scopeLabel } from "./local-drafts";
import { useProjectCardPreview } from "./use-project-card-preview";
import styles from "./project-card.module.css";

/** Home and Projects share the same saved-work hierarchy. The project label is
 * never replaced with a selected brand name or fabricated logo treatment. */
export function ProjectCard({ project, account, headingLevel = 2, date, actions, deletionStatus }: {
  project: LifecycleProject; account: VerifiedAccount; headingLevel?: 2 | 3; date: string; actions: ReactNode; deletionStatus?: ReactNode;
}) {
  const deleted = project.deletion_state !== "active";
  const owned = project.owner_id === account.userId;
  const { target, current, preview, rejectImage } = useProjectCardPreview(account, project.id, project.current_revision, owned && !deleted && project.scope !== "naming_only");
  if (!current || !owned) return null;
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const content = <>
    <div className={styles.preview} ref={target} data-project-preview={preview?.url ? "selected-logo" : "placeholder"}>
      {preview?.url
        // eslint-disable-next-line @next/next/no-img-element -- owner/hash-verified private object URL; no optimizer.
        ? <img src={preview.url} alt={`Saved selected logo${preview.name ? ` for ${preview.name}` : ""}`} onError={() => rejectImage(preview.url!)} />
        : <div className={styles.placeholder}><Icon name="brands" size={24} /><span>{deleted ? "Saved project" : project.scope === "naming_only" ? "Naming project" : preview?.status === "unavailable" ? "Preview unavailable" : preview?.status === "ready" ? "No logo selected" : "Saved project"}</span></div>}
    </div>
    <div className={styles.details}>
      <Heading className={styles.title} title={project.title}>{project.title}</Heading>
      <p className={styles.name} title={preview?.name ?? undefined}>{preview?.name ? `Logo brief: ${preview.name}` : deleted ? "Saved work retained" : "Continue your brand"}</p>
      <div className={styles.metadata}><span>{scopeLabel(project.scope)}</span>{!deleted && <span title={project.created_at}>{date}</span>}</div>
      {deleted ? <>{deletionStatus}<div className={`${styles.deletedFooter} project-footer`}><span title={project.deletion_requested_at ?? project.deleted_at ?? project.created_at}>{date}</span>{actions}</div></> : <span className={styles.footer}>Open project<Icon name="arrow" size={16} /></span>}
    </div>
  </>;
  return <article className={`${styles.card} ${headingLevel === 3 ? "home-brand-card" : "project-card"}${deleted ? " project-card--deleted" : ""}`} data-storage="account" data-project-id={project.id}>
    {deleted ? <div className={styles.deletedContent}>{content}</div> : <><Link className={styles.link} href={`/brands/account/${project.id}`} aria-label={`Continue ${project.title}`}>{content}</Link>{actions}</>}
  </article>;
}
