"use client";

import { useEffect, useRef, useState } from "react";
import { projectDeletionResponseSchema, type ProjectDeletionSummary } from "@/domain/project-deletion";
import { accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";

export type LifecycleProject = ProjectDeletionSummary;
export type ProjectDeletionAction = "delete" | "restore";
type Failure = { kind: "busy" | "refresh" | "uncertain"; message: string };

/** CAS binds the action to exactly the saved project and lifecycle the user saw. */
export async function changeProjectDeletion(project: LifecycleProject, action: ProjectDeletionAction, account: VerifiedAccount, signal: AbortSignal): Promise<LifecycleProject> {
  if (project.owner_id !== account.userId || (project.deleted_at !== null) !== (action === "restore")) throw new AccountRequestError(409);
  const { project: saved } = await accountRequest(`/api/projects/${project.id}/deletion`, projectDeletionResponseSchema, {
    method: action === "delete" ? "POST" : "DELETE",
    body: { expectedRevision: project.current_revision, expectedLifecycleVersion: project.lifecycle_version },
    expectedOwnerId: account.userId,
    signal,
  });
  if (saved.owner_id !== account.userId) throw new AccountRequestError(401);
  if (saved.id !== project.id || saved.current_revision !== project.current_revision || saved.lifecycle_version !== project.lifecycle_version + 1 ||
      (saved.deleted_at !== null) !== (action === "delete")) throw new AccountRequestError(502);
  return saved;
}

function failureFor(cause: unknown, action: ProjectDeletionAction): Failure {
  if (cause instanceof AccountRequestError) {
    if (cause.status === 409 && cause.code === "project_busy") return { kind: "busy", message: "This project has active work or work awaiting resolution. Open the project to check its status or stop it, then try again when that work has ended." };
    if (cause.status === 409) return { kind: "refresh", message: "This project changed since it was loaded. Refresh projects before trying again." };
    if (cause.status === 404) return { kind: "refresh", message: "This project is no longer available here. Refresh projects to check its current state." };
    if (cause.status === 400 || cause.status === 403 || cause.status === 413 || cause.status === 422) return { kind: "refresh", message: "This change could not be made. Refresh projects before trying again." };
  }
  return { kind: "uncertain", message: `${action === "delete" ? "Moving this project to Deleted projects" : "Restoring this project"} could not be confirmed. Refresh projects to check where it is before trying again.` };
}

/** Never infer rollback from an interrupted HTTP wait or replay an uncertain write. */
export function useProjectDeletion(account: VerifiedAccount, onChanged: (project: LifecycleProject, action: ProjectDeletionAction) => void) {
  const { isCurrent, expire } = useAccountSession();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current?.abort(); request.current = null; };
  }, [account]);

  async function change(project: LifecycleProject, action: ProjectDeletionAction) {
    if (!active.current || !isCurrent(account) || request.current || failure) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true); setFailure(null);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error("Project lifecycle deadline")); }, 15_000);
    });
    const current = () => active.current && request.current === controller && isCurrent(account);
    try {
      const saved = await Promise.race([changeProjectDeletion(project, action, account, controller.signal), deadline]);
      if (!current() || controller.signal.aborted) return;
      onChanged(saved, action);
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setFailure(failureFor(cause, action));
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        if (active.current && isCurrent(account)) setPending(false);
      }
    }
  }
  return { change, pending, failure, clearFailure: () => setFailure(null) };
}
