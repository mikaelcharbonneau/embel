"use client";

import Link from "next/link";
import { type ReactNode, useId, useSyncExternalStore } from "react";
import { MediaFrame } from "@/components/ui/media-frame";
import { Skeleton } from "@/components/ui/feedback";
import { formatAccountDate } from "@/domain/account-profile";
import { JOURNEY, projectJourneyMark } from "@/domain/journey";
import { projectStrategyHref } from "@/domain/project-handoff";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { needsStrategyRecovery } from "./account-draft-memory";
import { useAccountProfile } from "./account-profile-provider";
import { formatBrowserDate } from "./browser-local-date";
import type { LifecycleProject } from "./project-deletion-client";
import { useProjectCardPreview } from "./use-project-card-preview";
import styles from "./project-card.module.css";

/** "just now", "40 minutes ago", "3 hours ago", "yesterday", "4 days ago", then "Oct 31" (with the year when it
 * differs). Null for a date that cannot be read. */
export function relativeTime(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

// One shared clock for every card, so relative times stay current without a timer per card.
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;
function subscribeMinute(listener: () => void) {
  minuteListeners.add(listener);
  minuteTimer ??= setInterval(() => minuteListeners.forEach((notify) => notify()), 30_000);
  return () => {
    minuteListeners.delete(listener);
    if (!minuteListeners.size && minuteTimer) {
      clearInterval(minuteTimer);
      minuteTimer = null;
    }
  };
}
const currentMinute = () => Math.floor(Date.now() / 60_000);
const noMinute = () => null;

/** "Created 40 minutes ago", with the formatted date (in the account's date preferences) as its tooltip. */
function RelativeDate({ prefix, dateTime }: { prefix: string; dateTime: string }) {
  const minute = useSyncExternalStore(subscribeMinute, currentMinute, noMinute);
  const preferences = useAccountProfile()?.workspace?.saved.values;
  const valid = Number.isFinite(Date.parse(dateTime));
  if (!valid) return <span className="e-card__meta">Date unavailable</span>;
  const relative = minute === null ? null : relativeTime(dateTime, new Date(minute * 60_000));
  const full = preferences ? formatAccountDate(dateTime, preferences) : formatBrowserDate(dateTime);
  return (
    <time className="e-card__meta" dateTime={dateTime} title={full}>
      {prefix} {relative ?? full}
    </time>
  );
}

/** A placeholder in the card's exact shape, used while a card or a whole list loads. */
function SkeletonContent() {
  return (
    <>
      <div className="e-card__media" aria-hidden="true">
        <Skeleton shape="block" className={styles.fill} />
      </div>
      <div className="e-card__body" aria-hidden="true">
        <Skeleton shape="title" width={60} />
        <Skeleton shape="line" width={80} />
        <Skeleton shape="line" width={25} />
      </div>
    </>
  );
}

/** Placeholder cards while the project list loads; announced once by the caller. */
export function ProjectCardSkeletons({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="e-card project-card-skeleton">
          <SkeletonContent />
        </div>
      ))}
    </>
  );
}

/** The four steps of the brand at card size, with their sentence beside them. */
function JourneyProgress({
  id,
  projectId,
  href,
  sentence,
}: {
  id: string;
  projectId: string;
  href: string | null;
  sentence: string;
}) {
  const mark = href ? projectJourneyMark(projectId, href) : null;
  const step = mark?.current ? JOURNEY.findIndex((item) => item.id === mark.current) : -1;
  return (
    <div className={styles.progress}>
      {mark && (
        <span
          className="e-journey"
          role="img"
          aria-label={
            step < 0
              ? `All ${JOURNEY.length} steps complete`
              : `Step ${step + 1} of ${JOURNEY.length}: ${JOURNEY[step]!.label}`
          }
        >
          {mark.states.map((state, index) => (
            <span key={JOURNEY[index]!.id} className="e-journey__step" data-state={state} />
          ))}
        </span>
      )}
      <span id={id} className={`e-card__next ${styles.sentence}`}>
        {sentence}
      </span>
    </div>
  );
}

/** Home and Projects share one card: the chosen logo (or the name set in type) on top, then the name, the options
 * menu, the journey mark with the next step, and when the project was created. The whole card is one link, named by
 * the project's name and described by its step sentence, that opens the project at its next step. `actions` may use
 * the shown name. */
export function ProjectCard({
  project,
  account,
  headingLevel = 2,
  actions,
  deletionStatus,
  hidden = false,
}: {
  project: LifecycleProject;
  account: VerifiedAccount;
  headingLevel?: 2 | 3;
  actions: ReactNode | ((title: string) => ReactNode);
  deletionStatus?: ReactNode;
  /** Kept mounted but not shown (a search that does not match it), so showing it again needs no new read. */
  hidden?: boolean;
}) {
  const deleted = project.deletion_state !== "active";
  const owned = project.owner_id === account.userId;
  const { drafts } = useAccountSession();
  const sentenceId = useId();
  const recovering = useSyncExternalStore(
    drafts.subscribe,
    () => {
      const draft = drafts.get(project.id);
      return (
        draft?.ownerId === account.userId && draft.generation === account.generation && needsStrategyRecovery(draft)
      );
    },
    () => false,
  );
  const { target, current, reading, preview, rejectImage } = useProjectCardPreview(
    account,
    project.id,
    project.current_revision,
    owned && !deleted,
    true,
  );
  if (!current || !owned) return null;
  const hook = headingLevel === 3 ? "home-brand-card" : "project-card";
  // Show the card's shape, not a placeholder name, until the saved project is read.
  if (reading && !preview)
    return (
      <article
        ref={target}
        className={`e-card ${hook}`}
        data-storage="account"
        data-project-id={project.id}
        aria-busy="true"
        hidden={hidden}
      >
        <SkeletonContent />
      </article>
    );

  const title = preview?.selectedName || project.title;
  const artworkPending = reading && preview?.status === "loading";
  const stepPending = reading && !recovering && !preview?.action && !preview?.settled;
  const action = recovering
    ? { label: "Resume Strategy edits", href: projectStrategyHref(project.id) }
    : (preview?.action ?? { label: "Open project", href: `/brands/account/${project.id}` });
  // Only a verified next step draws the journey mark; the generic fallback says nothing about progress.
  const progressHref = preview?.action?.href ?? null;
  const ready = !recovering && progressHref !== null && projectJourneyMark(project.id, progressHref)?.current === null;
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const menu = typeof actions === "function" ? actions(title) : actions;
  const picture = artworkPending ? (
    <div className="e-card__media" aria-hidden="true">
      <Skeleton shape="block" className={styles.fill} />
    </div>
  ) : preview?.url ? (
    <div className={`e-card__media ${styles.logo}`} data-project-preview="selected-logo">
      {/* eslint-disable-next-line @next/next/no-img-element -- owner/hash-verified private object URL; no optimizer. */}
      <img
        src={preview.url}
        alt={`Saved selected logo${preview.name ? ` for ${preview.name}` : ""}`}
        onError={() => rejectImage(preview.url!)}
      />
    </div>
  ) : preview?.status === "unavailable" ? (
    <div className="e-card__media" data-project-preview="unavailable">
      <MediaFrame state="failed" failedText="Preview unavailable" className={styles.fill} />
    </div>
  ) : (
    <div className="e-card__media" data-project-preview="placeholder">
      <span className={styles.name} aria-hidden="true">
        {title}
      </span>
    </div>
  );

  if (deleted)
    return (
      <article
        ref={target}
        className={`e-card ${hook} project-card--deleted`}
        data-storage="account"
        data-project-id={project.id}
        hidden={hidden}
      >
        {picture}
        <div className="e-card__body">
          <Heading className="e-card__title e-card__title--two-line" title={title}>
            {title}
          </Heading>
          {deletionStatus}
          <div className={`${styles.footer} project-footer`}>
            <RelativeDate prefix="Deleted" dateTime={project.deletion_requested_at ?? project.deleted_at ?? ""} />
            {menu}
          </div>
        </div>
      </article>
    );
  return (
    <article
      ref={target}
      className={`e-card e-card--interactive ${styles.card} ${hook}`}
      data-storage="account"
      data-project-id={project.id}
      aria-busy={artworkPending || stepPending || undefined}
      hidden={hidden}
    >
      {picture}
      <div className="e-card__body">
        <div className={styles.row}>
          <Heading className="e-card__title e-card__title--two-line" title={title}>
            <Link className="e-card__link" href={action.href} aria-describedby={stepPending ? undefined : sentenceId}>
              {title}
            </Link>
          </Heading>
          {menu}
        </div>
        {stepPending ? (
          <Skeleton shape="line" width={80} className={styles.pendingStep} />
        ) : (
          <JourneyProgress
            id={sentenceId}
            projectId={project.id}
            href={recovering ? null : progressHref}
            sentence={ready ? "Brand kit ready" : action.label}
          />
        )}
        <RelativeDate prefix="Created" dateTime={project.created_at} />
      </div>
    </article>
  );
}
