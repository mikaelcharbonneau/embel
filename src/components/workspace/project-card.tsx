"use client";

import Link from "next/link";
import { type ReactNode, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icon";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { needsStrategyRecovery } from "./account-draft-memory";
import { projectStrategyHref } from "@/domain/project-handoff";
import type { LifecycleProject } from "./project-deletion-client";
import { useProjectCardPreview } from "./use-project-card-preview";
import styles from "./project-card.module.css";

/** "Today", "Yesterday" or "Oct 31" (with the year when it differs). */
export function shortDate(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString("en", { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/** Neutral blocks with no words, used while a card or a whole list loads. */
function SkeletonContent() {
  return <div className={styles.skeleton} aria-hidden="true">
    <div className={`${styles.preview} ${styles.block}`} />
    <div className={styles.details}>
      <div className={styles.row}><span className={`${styles.block} ${styles.lineTitle}`} /><span className={`${styles.block} ${styles.lineDate}`} /></div>
      <span className={`${styles.block} ${styles.lineStep}`} />
    </div>
  </div>;
}

/** Placeholder cards while the project list loads; announced once by the caller. */
export function ProjectCardSkeletons({ count }: { count: number }) {
  return <>{Array.from({ length: count }, (_, index) => <div key={index} className={`${styles.card} project-card-skeleton`}><SkeletonContent /></div>)}</>;
}

function initial(title: string) {
  return Array.from(title.trim())[0]?.toLocaleUpperCase() ?? "";
}

/** Home and Projects share one card: the saved logo or a neutral preview, the
 * project's name and date, then its next step. `actions` may use the shown name. */
export function ProjectCard({ project, account, headingLevel = 2, date, actions, deletionStatus }: {
  project: LifecycleProject; account: VerifiedAccount; headingLevel?: 2 | 3; date: string;
  actions: ReactNode | ((title: string) => ReactNode); deletionStatus?: ReactNode;
}) {
  const deleted = project.deletion_state !== "active";
  const owned = project.owner_id === account.userId;
  const { drafts } = useAccountSession();
  const recovering = useSyncExternalStore(drafts.subscribe, () => {
    const draft = drafts.get(project.id);
    return draft?.ownerId === account.userId && draft.generation === account.generation && needsStrategyRecovery(draft);
  }, () => false);
  const { target, current, reading, preview, rejectImage } = useProjectCardPreview(account, project.id, project.current_revision, owned && !deleted, project.scope !== "naming_only");
  if (!current || !owned) return null;
  const className = `${styles.card} ${headingLevel === 3 ? "home-brand-card" : "project-card"}${deleted ? " project-card--deleted" : ""}`;
  // Show neutral blocks, not a placeholder name, until the saved project is read.
  if (reading && !preview) return <article ref={target} className={className} data-storage="account" data-project-id={project.id} aria-busy="true"><SkeletonContent /></article>;

  const title = preview?.selectedName || project.title;
  const artworkPending = reading && preview?.status === "loading";
  const stepPending = reading && !recovering && !preview?.action && !preview?.settled;
  const action = recovering ? { label: "Resume Strategy edits", href: projectStrategyHref(project.id) }
    : preview?.action ?? { label: "Open project", href: `/brands/account/${project.id}` };
  const label = deleted ? null : project.scope === "naming_only" ? "Naming project" : preview?.status === "unavailable" ? "Preview unavailable" : preview?.status === "ready" ? "No logo yet" : null;
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const menu = typeof actions === "function" ? actions(title) : actions;
  const thumbnail = artworkPending ? <div className={`${styles.preview} ${styles.block}`} aria-hidden="true" />
    : preview?.url ? <div className={styles.preview} data-project-preview="selected-logo">
      {/* eslint-disable-next-line @next/next/no-img-element -- owner/hash-verified private object URL; no optimizer. */}
      <img src={preview.url} alt={`Saved selected logo${preview.name ? ` for ${preview.name}` : ""}`} onError={() => rejectImage(preview.url!)} />
    </div>
    : <div className={`${styles.preview} ${styles.placeholder}`} data-project-preview="placeholder">
      {preview?.idea ? <p className={styles.idea}>{preview.idea}</p> : <span className={styles.initial} aria-hidden="true">{initial(title)}</span>}
      {label && <span className={styles.badge}>{label}</span>}
    </div>;
  const heading = <div className={styles.row}><Heading className={styles.title} title={title}>{title}</Heading>{!deleted && <span className={styles.date} title={project.created_at}>{date}</span>}</div>;

  if (deleted) return <article ref={target} className={className} data-storage="account" data-project-id={project.id}>
    <div className={styles.content}>{thumbnail}<div className={styles.details}>{heading}{deletionStatus}
      <div className={`${styles.deletedFooter} project-footer`}><span title={project.deletion_requested_at ?? project.deleted_at ?? project.created_at}>{date}</span>{menu}</div>
    </div></div>
  </article>;
  return <article ref={target} className={className} data-storage="account" data-project-id={project.id} aria-busy={artworkPending || stepPending || undefined}>
    <Link className={styles.link} href={action.href} aria-label={`${action.label} · ${title}`}>
      {thumbnail}
      <div className={styles.details}>{heading}
        {stepPending ? <span className={`${styles.block} ${styles.lineStep}`} aria-hidden="true" /> : <span className={styles.next}>{action.label}<Icon name="arrow" size={14} /></span>}
      </div>
    </Link>
    {menu}
  </article>;
}
