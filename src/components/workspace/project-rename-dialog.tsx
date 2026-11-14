"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/field";
import { InlineMessage } from "@/components/ui/message";
import { useToast } from "@/components/ui/toast";
import { accountProjectResponseSchema, accountRevisionResponseSchema, type AccountProject } from "@/domain/project-api";
import { AccountRequestError, accountRequest } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { boundedAccountRequest } from "./bounded-account-request";
import type { LifecycleProject } from "./project-deletion-client";

/** Matches `displayName` in the saved context. */
const MAX_NAME_LENGTH = 160;

type Problem = { kind: "conflict" | "failed"; message: string };

/**
 * Renames a project: the name its cards and project bar show from then on, even after a brand name is chosen. The
 * chosen brand name, logo and brand kit are not touched. The name is saved as a new revision of the latest saved
 * project; a project that changed meanwhile is reloaded and the person saves again. Render it only while open.
 */
export function ProjectRenameDialog({
  project,
  account,
  name,
  onClose,
  onRenamed,
}: {
  project: LifecycleProject;
  account: VerifiedAccount;
  /** The name the card shows now, which prefills the field. */
  name: string;
  onClose: () => void;
  /** The saved name and the revision that holds it. */
  onRenamed: (name: string, revision: number) => void;
}) {
  const { isCurrent, expire } = useAccountSession();
  const toast = useToast();
  const [value, setValue] = useState(name);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const field = () => form.current?.querySelector("input");
  const latest = useRef<AccountProject | null>(null);
  const request = useRef<AbortController | null>(null);

  // The Dialog opens (and records the control to return focus to) first; then the name is ready to edit.
  useEffect(() => {
    field()?.focus();
    field()?.select();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, []);

  async function read(signal: AbortSignal) {
    const { project: saved } = await accountRequest(`/api/projects/${project.id}`, accountProjectResponseSchema, {
      signal,
      expectedOwnerId: account.userId,
    });
    if (saved.id !== project.id || saved.owner_id !== account.userId) throw new AccountRequestError(502);
    latest.current = saved;
    return saved;
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (request.current || !isCurrent(account)) return;
    const next = value.trim();
    if (!next) {
      setFieldError("Enter a name.");
      field()?.focus();
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const live = () => request.current === controller && !controller.signal.aborted && isCurrent(account);
    setSaving(true);
    setFieldError(null);
    setProblem(null);
    let expectedRevision: number | null = null;
    function renamed(revision: number) {
      onRenamed(next, revision);
      toast("Project renamed");
      onClose();
    }
    try {
      const saved = latest.current ?? (await read(controller.signal));
      if (!live()) return;
      if (saved.context.displayName === next) {
        // Already saved under this name (an earlier attempt whose reply was lost, or no change).
        onClose();
        return;
      }
      expectedRevision = saved.current_revision;
      const context = { ...saved.context, displayName: next };
      const { revision } = await boundedAccountRequest(`/api/projects/${project.id}`, accountRevisionResponseSchema, {
        method: "PATCH",
        body: { expectedRevision, context },
        signal: controller.signal,
      });
      if (!live()) return;
      if (revision.owner_id !== account.userId || revision.project_id !== project.id) {
        expire(account);
        return;
      }
      if (revision.revision !== expectedRevision + 1 || revision.context.displayName !== next)
        throw new AccountRequestError(502);
      latest.current = null;
      renamed(revision.revision);
    } catch (cause) {
      if (!live()) return;
      if (cause instanceof AccountRequestError && cause.status === 401) {
        expire(account);
        return;
      }
      const conflict = cause instanceof AccountRequestError && cause.status === 409;
      // A conflict, a lost reply or a server failure may hide a saved name: read the project before saying anything.
      if (expectedRevision !== null && (!(cause instanceof AccountRequestError) || conflict || cause.status >= 408)) {
        try {
          const reloaded = await read(controller.signal);
          if (!live()) return;
          if (reloaded.current_revision > expectedRevision && reloaded.context.displayName === next) {
            latest.current = null;
            renamed(reloaded.current_revision);
            return;
          }
        } catch (reloadCause) {
          if (!live()) return;
          if (reloadCause instanceof AccountRequestError && reloadCause.status === 401) {
            expire(account);
            return;
          }
          latest.current = null;
        }
      }
      setProblem(
        conflict
          ? {
              kind: "conflict",
              message:
                "This project changed while you were renaming it. Its latest version has been loaded. Try again to save the new name.",
            }
          : {
              kind: "failed",
              message:
                cause instanceof AccountRequestError && cause.status === 404
                  ? "This project is no longer available to this account."
                  : "The name couldn’t be saved. Check your connection and try again.",
            },
      );
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (isCurrent(account)) setSaving(false);
      }
    }
  }

  const formId = `project-rename-${project.id}`;
  return (
    <Dialog
      size="sm"
      title="Rename project"
      busy={saving}
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {problem ? "Try again" : "Save name"}
          </Button>
        </>
      }
    >
      <form ref={form} id={formId} noValidate onSubmit={(event) => void save(event)}>
        <TextField
          label="Project name"
          hint="This changes the name on your cards and project bar. Your brand name and brand kit stay the same."
          value={value}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          spellCheck={false}
          error={fieldError ?? undefined}
          readOnly={saving}
          onChange={(event) => {
            setValue(event.target.value);
            if (fieldError) setFieldError(null);
          }}
        />
      </form>
      {problem && (
        <InlineMessage tone="danger">
          <p>{problem.message}</p>
        </InlineMessage>
      )}
    </Dialog>
  );
}
