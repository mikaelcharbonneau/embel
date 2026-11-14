"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Button, IconButton, Spinner } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Badge, EmptyState, LoadingRegion, Skeleton } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { InlineMessage } from "@/components/ui/message";
import {
  groupJobActivity,
  jobActivityDetail,
  jobActivitySchema,
  jobActivitySummary,
  splitJobActivity,
  type JobActivity,
  type JobActivityGroup,
} from "@/domain/job-activity";
import { accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import styles from "./generation-activity.module.css";

/**
 * The clock button that opens Activity. `labeled` draws it as a menu row with its name. The account menu may
 * render ActivityDialog itself instead, so the dialog never lives inside a hidden menu.
 */
export function GenerationActivity({ labeled = false }: { labeled?: boolean }) {
  const { session } = useAccountSession();
  const [open, setOpen] = useState(false);
  if (session.status !== "ready") return null;
  return (
    <>
      {labeled ? (
        <button type="button" className="e-menu__item" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <Icon name="clock" size="sm" />
          Activity
        </button>
      ) : (
        <IconButton icon="clock" label="Activity" aria-haspopup="dialog" onClick={() => setOpen(true)} />
      )}
      {open && <ActivityDialog onClose={() => setOpen(false)} />}
    </>
  );
}

const sessionKey = (session: ReturnType<typeof useAccountSession>["session"]) =>
  session.status === "ready" ? `${session.userId}:${session.generation}` : null;

/**
 * The Activity dialog. Render it only while it is open; it loads and polls only while mounted. It belongs to the
 * account that was verified when it opened: if that account signs out or changes, it closes itself.
 */
export function ActivityDialog({ onClose }: { onClose: () => void }) {
  const { session } = useAccountSession();
  const [openedFor] = useState(() => sessionKey(session));
  const current = openedFor !== null && sessionKey(session) === openedFor;
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!current) close.current();
  }, [current]);
  if (!current || session.status !== "ready") return null;
  return <OwnedActivityDialog account={session} onClose={onClose} />;
}

function OwnedActivityDialog({ account, onClose }: { account: VerifiedAccount; onClose: () => void }) {
  const { isCurrent, expire } = useAccountSession();
  const [snapshot, setSnapshot] = useState<{ activity: JobActivity; readAt: number } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      let active = false;
      const read = new AbortController();
      const abortRead = () => read.abort();
      controller.signal.addEventListener("abort", abortRead, { once: true });
      const deadline = setTimeout(abortRead, 15_000);
      try {
        const reply = await accountRequest("/api/jobs", jobActivitySchema, { signal: read.signal });
        if (controller.signal.aborted || read.signal.aborted || !isCurrent(account)) return;
        if (reply.ownerId !== account.userId) {
          expire(account);
          return;
        }
        // Times read relative to this check; an identical reply keeps the current render.
        const readAt = Date.now();
        setSnapshot((previous) => (previous?.activity === reply ? previous : { activity: reply, readAt }));
        setError(false);
        active = reply.active.length > 0;
      } catch (cause) {
        if (controller.signal.aborted || !isCurrent(account)) return;
        if (cause instanceof AccountRequestError && cause.status === 401) {
          expire(account);
          return;
        }
        setError(true);
      } finally {
        clearTimeout(deadline);
        controller.signal.removeEventListener("abort", abortRead);
        if (!controller.signal.aborted && isCurrent(account))
          timer = setTimeout(() => void refresh(), active ? 3000 : 15000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [account, expire, isCurrent, retry]);

  const groups = snapshot ? groupJobActivity(snapshot.activity) : [];
  const { attention, finished } = splitJobActivity(groups);
  const tryAgain = (
    <Button size="sm" icon="rotate-ccw" onClick={() => setRetry((value) => value + 1)}>
      Try again
    </Button>
  );
  return (
    <Dialog title="Activity" onClose={onClose}>
      {error && (
        <InlineMessage tone="danger" actions={tryAgain}>
          {snapshot
            ? "Your activity couldn’t be refreshed. You’re seeing the last update."
            : "Your activity couldn’t be loaded. Check your connection, then try again."}
        </InlineMessage>
      )}
      {!snapshot && !error && <ActivitySkeleton />}
      {snapshot && !groups.length && (
        <EmptyState
          icon="clock"
          headingLevel={3}
          title="Nothing has run yet"
          text="When Embel is making names, logos or images for you, you can follow them here."
        />
      )}
      {snapshot && groups.length > 0 && (
        <>
          <p>{jobActivitySummary(groups)}</p>
          <ActivitySection title="Running and failed" groups={attention} now={snapshot.readAt} onClose={onClose} />
          <ActivitySection title="Done" groups={finished} now={snapshot.readAt} onClose={onClose} />
          <p className={styles.note}>This is your latest activity. Open a project to see everything made for it.</p>
        </>
      )}
    </Dialog>
  );
}

function ActivitySection({
  title,
  groups,
  now,
  onClose,
}: {
  title: string;
  groups: JobActivityGroup[];
  now: number;
  onClose: () => void;
}) {
  const id = useId();
  if (!groups.length) return null;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 className={styles.heading} id={id}>
        {title}
      </h3>
      <ul>
        {groups.map((group) => (
          <li key={group.id} className={styles.row}>
            <div className={styles.main}>
              {/* The title opens the project at the step this action belongs to. */}
              <Link className={styles.title} href={group.href} onClick={onClose}>
                <span>{group.projectTitle}</span> · {group.label}
                <Icon name="arrow-right" size="sm" />
              </Link>
              <p className={styles.detail}>{jobActivityDetail(group, now)}</p>
            </div>
            <GroupStatus status={group.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Status is always an icon and a word. */
function GroupStatus({ status }: { status: JobActivityGroup["status"] }) {
  switch (status) {
    case "failed":
      return (
        <Badge tone="danger" icon="circle-alert">
          Failed
        </Badge>
      );
    case "unconfirmed":
      return (
        <Badge tone="warning" icon="triangle-alert">
          Not confirmed
        </Badge>
      );
    case "running":
    case "stopping":
      return (
        <span className={styles.status}>
          <Spinner />
          {status === "running" ? "Running" : "Stopping"}
        </span>
      );
    case "partial":
      return (
        <span className={styles.status}>
          <Icon name="triangle-alert" size="sm" />
          Partial results
        </span>
      );
    case "stopped":
      return (
        <span className={styles.status}>
          <Icon name="square" size="sm" />
          Stopped
        </span>
      );
    case "done":
      return (
        <span className={styles.status}>
          <Icon name="check" size="sm" />
          Done
        </span>
      );
  }
}

/** Skeleton rows in the shape of the list, so nothing moves when it arrives. */
function ActivitySkeleton() {
  return (
    <LoadingRegion label="Loading your activity">
      <Skeleton width={60} />
      <ul>
        {[0, 1, 2, 3].map((row) => (
          <li key={row} className={styles.row}>
            <span className={styles.skeletonMain}>
              <Skeleton width={60} />
              <Skeleton width={25} />
            </span>
            <Skeleton className={styles.skeletonStatus} />
          </li>
        ))}
      </ul>
    </LoadingRegion>
  );
}
