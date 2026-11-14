"use client";

import { useEffect, useRef, useState } from "react";
import { AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { readProjectDeletion, type LifecycleProject } from "./project-deletion-client";

function deletionIsPending(project: LifecycleProject) {
  return project.deletion_state === "stopping" || project.deletion_state === "awaiting_resolution";
}

/** This only observes durable server state. It never cancels, restarts or retries work. */
function useDeletionStatus(
  account: VerifiedAccount,
  project: LifecycleProject,
  onUpdated: (project: LifecycleProject) => void,
) {
  const { isCurrent, expire } = useAccountSession();
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useRef(project);
  const publish = useRef(onUpdated);
  const fence = `${account.userId}:${account.generation}:${project.id}:${project.lifecycle_version}:${project.deletion_state}`;
  useEffect(() => {
    latest.current = project;
    publish.current = onUpdated;
  }, [project, onUpdated]);
  const pending = deletionIsPending(project);

  useEffect(() => {
    if (!pending) return;
    let disposed = false,
      failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | null = null;
    const cadence = project.deletion_state === "awaiting_resolution" ? 30_000 : 5_000;
    const current = () => !disposed && isCurrent(account);
    function schedule(delay: number) {
      clearTimeout(timer);
      if (current() && document.visibilityState !== "hidden" && deletionIsPending(latest.current))
        timer = setTimeout(() => void check(), delay);
    }
    async function check() {
      if (!current() || request || document.visibilityState === "hidden" || !deletionIsPending(latest.current)) return;
      const captured = latest.current;
      const controller = new AbortController();
      request = controller;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let nextDelay = cadence,
        keepChecking = true;
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          controller.abort();
          reject(new Error("Deletion status deadline"));
        }, 15_000);
      });
      try {
        const saved = await Promise.race([readProjectDeletion(captured, account, controller.signal), timeout]);
        if (!current() || request !== controller || controller.signal.aborted) return;
        failures = 0;
        setFailure(null);
        // Derived completion can advance at the SAME lifecycle version. An old
        // read must never replace a later restore or a new deletion request.
        if (
          saved.lifecycle_version >= latest.current.lifecycle_version &&
          saved.current_revision >= latest.current.current_revision
        ) {
          keepChecking = deletionIsPending(saved);
          nextDelay = saved.deletion_state === "awaiting_resolution" ? 30_000 : 5_000;
          publish.current(saved);
        }
      } catch (cause) {
        if (!current() || request !== controller) return;
        if (cause instanceof AccountRequestError && cause.status === 401) {
          expire(account);
          keepChecking = false;
          return;
        }
        failures += 1;
        setFailure(fence);
        nextDelay = Math.min(60_000, Math.max(30_000, cadence * 2 ** failures));
      } finally {
        clearTimeout(deadline);
        if (request === controller) {
          request = null;
          if (keepChecking) schedule(nextDelay);
        }
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") {
        request?.abort();
        request = null;
      } else schedule(0);
    }
    schedule(cadence);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      disposed = true;
      clearTimeout(timer);
      request?.abort();
      request = null;
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [account, expire, fence, isCurrent, pending, project.deletion_state]);
  return failure === fence;
}

export function ProjectDeletionStatus({
  account,
  project,
  onUpdated,
  compact = false,
}: {
  account: VerifiedAccount;
  project: LifecycleProject;
  onUpdated: (project: LifecycleProject) => void;
  compact?: boolean;
}) {
  const failed = useDeletionStatus(account, project, onUpdated);
  if (project.deletion_state === "active") return null;
  // Acknowledged deletion is complete for the workspace even when earlier work
  // still needs cancellation or accounting evidence. Never present that cleanup
  // as a prerequisite for removing or restoring the project.
  return (
    <div
      className={`project-deletion-status${compact ? " project-deletion-status--compact" : ""}`}
      role={compact ? undefined : "status"}
    >
      <span className="project-deletion-state project-deletion-state--deleted">Deleted</span>
      {project.deletion_state === "stopping" && <p>Cancellation requested</p>}
      {failed && <p>Work status could not be checked. The project is still deleted.</p>}
    </div>
  );
}
