"use client";

import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";
import { InlineMessage } from "@/components/ui/message";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { useProjectDeletion, type LifecycleProject, type ProjectDeletionAction } from "./project-deletion-client";
import "@/styles/project-card-actions.css";

/** The card's options menu (Delete) for an active project, or its Restore button once deleted. Both confirm in a
 * small dialog that stays open while the change runs and shows any failure with its recovery inside it. */
export function ProjectCardActions({
  project,
  account,
  name = project.title,
  onChanged,
  onReload,
}: {
  project: LifecycleProject;
  account: VerifiedAccount;
  /** The name the card shows, which may be the chosen brand name. */
  name?: string;
  onChanged: (project: LifecycleProject, action: ProjectDeletionAction) => void;
  onReload: () => Promise<boolean>;
}) {
  const { isCurrent } = useAccountSession();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const refreshLock = useRef(false);
  const action: ProjectDeletionAction = project.deletion_state === "active" ? "delete" : "restore";
  // Notices about this change name the project the way its card did.
  const { change, check, pending, reconciling, failure, clearFailure } = useProjectDeletion(account, (saved, done) =>
    onChanged(saved.title === name ? saved : { ...saved, title: name }, done),
  );
  const busy = pending || refreshing;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // The Dialog opens (and records the control to return focus to) first; then focus starts on Cancel.
  useEffect(() => {
    if (dialogOpen && !cancel.current?.disabled) cancel.current?.focus();
  }, [dialogOpen]);

  function openAction() {
    if (!isCurrent(account) || busy) return;
    setDialogOpen(true);
    setRefreshFailed(false);
    if (action === "restore" && !failure) void change(project, action);
  }
  function closeDialog() {
    if (!busy) setDialogOpen(false);
  }
  async function refresh() {
    if (refreshLock.current || pending || !isCurrent(account)) return;
    refreshLock.current = true;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const refreshed = await onReload();
      if (!active.current || !isCurrent(account)) return;
      if (refreshed) {
        clearFailure();
        setDialogOpen(false);
      } else setRefreshFailed(true);
    } catch {
      if (active.current && isCurrent(account)) setRefreshFailed(true);
    } finally {
      refreshLock.current = false;
      if (active.current && isCurrent(account)) setRefreshing(false);
    }
  }

  return (
    <div className={action === "delete" ? "e-card__action" : undefined}>
      {action === "delete" ? (
        <Menu
          label={`Actions for ${name}`}
          items={[{ kind: "action", label: "Delete", icon: "trash", danger: true, onSelect: openAction }]}
          trigger={(props) => (
            <IconButton
              {...props}
              icon="menu"
              label={`Project options for ${name}`}
              size="sm"
              tooltip={false}
              onKeyDown={(event) => {
                if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !props["aria-expanded"]) {
                  event.preventDefault();
                  props.onClick();
                }
              }}
            />
          )}
        />
      ) : (
        <Button size="sm" icon="refresh" onClick={openAction} disabled={pending}>
          {pending ? "Restoring…" : "Restore"}
        </Button>
      )}
      {dialogOpen && (
        <Dialog
          size="sm"
          title={
            <>
              {action === "delete" ? "Delete" : "Restore"} “{name}”{action === "delete" ? "?" : ""}
            </>
          }
          description={
            action === "delete"
              ? "It moves to Deleted projects, where you can restore it. Its assets and history are kept. Deleting requests cancellation of active work. Work already started may still finish or incur usage. Restoring won’t restart cancelled AI work."
              : "This returns the project to Projects. Restoring won’t restart cancelled AI work."
          }
          busy={busy}
          onClose={closeDialog}
          footer={
            <>
              <Button ref={cancel} disabled={busy} onClick={closeDialog}>
                {failure || action === "restore" ? "Close" : "Cancel"}
              </Button>
              {failure ? (
                <Button
                  disabled={busy}
                  loading={refreshing}
                  onClick={() => {
                    if (failure.kind === "retry") void change(project, action);
                    else if (failure.kind === "uncertain") void check(project, action);
                    else void refresh();
                  }}
                >
                  {refreshing
                    ? "Refreshing…"
                    : failure.kind === "retry"
                      ? "Try again"
                      : failure.kind === "uncertain"
                        ? "Check status"
                        : "Refresh projects"}
                </Button>
              ) : (
                action === "delete" && (
                  <Button
                    variant="danger-filled"
                    disabled={busy}
                    loading={pending}
                    onClick={() => void change(project, action)}
                  >
                    {pending ? (reconciling ? "Checking status…" : "Moving project…") : "Delete project"}
                  </Button>
                )
              )}
            </>
          }
        >
          {pending && (
            <p className="e-muted" role="status">
              {reconciling
                ? "Checking project status…"
                : action === "delete"
                  ? "Moving to Deleted projects…"
                  : "Restoring project…"}
            </p>
          )}
          {failure && (
            <InlineMessage tone="danger">
              <p>{failure.message}</p>
              {refreshFailed && <p>Projects could not be refreshed. Check your connection and try again.</p>}
            </InlineMessage>
          )}
        </Dialog>
      )}
    </div>
  );
}
