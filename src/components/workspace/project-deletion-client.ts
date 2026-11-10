"use client";

import { useEffect, useRef, useState } from "react";
import { projectDeletionResponseSchema, type ProjectDeletionSummary } from "@/domain/project-deletion";
import { accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";

export type LifecycleProject = ProjectDeletionSummary;
export type ProjectDeletionAction = "delete" | "restore";
type Failure = { kind: "retry" | "refresh" | "uncertain"; message: string };

/** CAS binds the action to exactly the saved project and lifecycle the user saw. */
export async function changeProjectDeletion(
  project: LifecycleProject,
  action: ProjectDeletionAction,
  account: VerifiedAccount,
  signal: AbortSignal,
): Promise<LifecycleProject> {
  if (project.owner_id !== account.userId || (project.deletion_state !== "active") !== (action === "restore"))
    throw new AccountRequestError(409);
  const { project: saved } = await accountRequest(
    `/api/projects/${project.id}/deletion`,
    projectDeletionResponseSchema,
    {
      method: action === "delete" ? "POST" : "DELETE",
      body: {
        expectedRevision: project.current_revision,
        expectedLifecycleVersion: project.lifecycle_version,
        ...(action === "delete" ? { stopActiveWork: true } : {}),
      },
      expectedOwnerId: account.userId,
      signal,
    },
  );
  if (saved.owner_id !== account.userId) throw new AccountRequestError(401);
  if (
    saved.id !== project.id ||
    saved.current_revision !== project.current_revision ||
    saved.lifecycle_version !== project.lifecycle_version + 1 ||
    (saved.deletion_state !== "active") !== (action === "delete")
  )
    throw new AccountRequestError(502);
  return saved;
}

function failureFor(cause: unknown, action: ProjectDeletionAction): Failure {
  if (cause instanceof AccountRequestError) {
    if (cause.status === 409 && cause.code === "project_busy")
      return {
        kind: "refresh",
        message: "This request could not be completed yet. Refresh projects to check its current status.",
      };
    if (cause.status === 409)
      return {
        kind: "refresh",
        message: "This project changed since it was loaded. Refresh projects before trying again.",
      };
    if (cause.status === 404)
      return {
        kind: "refresh",
        message: "This project is no longer available here. Refresh projects to check its current state.",
      };
    if (cause.status === 400 || cause.status === 403 || cause.status === 413 || cause.status === 422)
      return { kind: "refresh", message: "This change could not be made. Refresh projects before trying again." };
  }
  return {
    kind: "uncertain",
    message: `${action === "delete" ? "Moving this project to Deleted projects" : "Restoring this project"} could not be confirmed. Check its status before trying again.`,
  };
}

/** Status reads share the same owner and lifecycle fences as mutations. */
export async function readProjectDeletion(
  project: LifecycleProject,
  account: VerifiedAccount,
  signal: AbortSignal,
): Promise<LifecycleProject> {
  const { project: saved } = await accountRequest(
    `/api/projects/${project.id}/deletion`,
    projectDeletionResponseSchema,
    { signal, expectedOwnerId: account.userId },
  );
  if (saved.owner_id !== account.userId) throw new AccountRequestError(401);
  if (
    saved.id !== project.id ||
    saved.lifecycle_version < project.lifecycle_version ||
    saved.current_revision < project.current_revision
  )
    throw new AccountRequestError(502);
  return saved;
}

/** Never infer rollback from an interrupted wait; reconcile by reading, not replaying. */
export function useProjectDeletion(
  account: VerifiedAccount,
  onChanged: (project: LifecycleProject, action: ProjectDeletionAction) => void,
) {
  const { isCurrent, expire } = useAccountSession();
  const [phase, setPhase] = useState<"idle" | "changing" | "checking">("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, [account]);

  async function perform(project: LifecycleProject, action: ProjectDeletionAction, checkOnly = false) {
    if (
      !active.current ||
      !isCurrent(account) ||
      request.current ||
      (!checkOnly && failure && failure.kind !== "retry")
    )
      return;
    let ownedController: AbortController | null = null;
    const current = () => active.current && request.current === ownedController && isCurrent(account);
    setPhase(checkOnly ? "checking" : "changing");
    setFailure(null);
    async function bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const controller = new AbortController();
      ownedController = controller;
      request.current = controller;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Project lifecycle deadline"));
        }, 15_000);
      });
      try {
        return await Promise.race([work(controller.signal), deadline]);
      } finally {
        clearTimeout(timeout);
      }
    }
    async function reconcile() {
      setPhase("checking");
      const saved = await bounded((signal) => readProjectDeletion(project, account, signal));
      if (!current()) return;
      if (
        saved.current_revision === project.current_revision &&
        saved.lifecycle_version === project.lifecycle_version + 1 &&
        (saved.deletion_state !== "active") === (action === "delete")
      )
        onChanged(saved, action);
      else if (
        saved.current_revision === project.current_revision &&
        saved.lifecycle_version === project.lifecycle_version &&
        (saved.deletion_state !== "active") === (action === "restore")
      )
        setFailure({
          kind: "retry",
          message: `The ${action === "delete" ? "deletion" : "restoration"} has not been confirmed. You can try again safely.`,
        });
      else
        setFailure({
          kind: "refresh",
          message: "This project changed while its status was checked. Refresh projects before trying again.",
        });
    }
    try {
      if (checkOnly) await reconcile();
      else {
        try {
          const saved = await bounded((signal) => changeProjectDeletion(project, action, account, signal));
          if (current()) onChanged(saved, action);
        } catch (cause) {
          if (!current()) return;
          if (cause instanceof AccountRequestError && cause.status === 401) {
            expire(account);
            return;
          }
          if (!(cause instanceof AccountRequestError) || cause.status >= 500 || cause.status === 409) await reconcile();
          else setFailure(failureFor(cause, action));
        }
      }
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setFailure(failureFor(cause, action));
    } finally {
      if (request.current === ownedController) {
        request.current = null;
        if (active.current && isCurrent(account)) setPhase("idle");
      }
    }
  }
  return {
    change: (project: LifecycleProject, action: ProjectDeletionAction) => perform(project, action),
    check: (project: LifecycleProject, action: ProjectDeletionAction) => perform(project, action, true),
    pending: phase !== "idle",
    reconciling: phase === "checking",
    failure,
    clearFailure: () => setFailure(null),
  };
}
