"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { useProjectDeletion, type LifecycleProject, type ProjectDeletionAction } from "./project-deletion-client";
import "@/styles/project-card-actions.css";

export function ProjectCardActions({ project, account, onChanged, onReload }: {
  project: LifecycleProject;
  account: VerifiedAccount;
  onChanged: (project: LifecycleProject, action: ProjectDeletionAction) => void;
  onReload: () => Promise<boolean>;
}) {
  const { isCurrent } = useAccountSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuItem = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const dialogHeading = useRef<HTMLHeadingElement>(null);
  const active = useRef(false);
  const refreshLock = useRef(false);
  const id = useId();
  const action: ProjectDeletionAction = project.deleted_at === null ? "delete" : "restore";
  const { change, pending, failure, clearFailure } = useProjectDeletion(account, onChanged);
  const busy = pending || refreshing;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!menuOpen) return;
    menuItem.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);
  useEffect(() => {
    const element = dialog.current;
    if (!dialogOpen || !element) return;
    const returnFocus = trigger.current;
    element.showModal();
    if (cancel.current?.disabled) dialogHeading.current?.focus();
    else cancel.current?.focus();
    return () => { element.close(); if (returnFocus?.isConnected) returnFocus.focus(); };
  }, [dialogOpen]);

  function openAction() {
    if (!isCurrent(account) || busy) return;
    setMenuOpen(false); setDialogOpen(true); setRefreshFailed(false);
    if (action === "restore" && !failure) void change(project, action);
  }
  function closeDialog() { if (!busy) setDialogOpen(false); }
  async function refresh() {
    if (refreshLock.current || pending || !isCurrent(account)) return;
    refreshLock.current = true; setRefreshing(true); setRefreshFailed(false);
    try {
      const refreshed = await onReload();
      if (!active.current || !isCurrent(account)) return;
      if (refreshed) { clearFailure(); setDialogOpen(false); }
      else setRefreshFailed(true);
    } catch {
      if (active.current && isCurrent(account)) setRefreshFailed(true);
    } finally {
      refreshLock.current = false;
      if (active.current && isCurrent(account)) setRefreshing(false);
    }
  }

  return <div className={action === "delete" ? "project-card-actions" : "project-card-restore"} ref={root} onClick={event => event.stopPropagation()} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
  }}>
    {action === "delete" ? <>
      <button ref={trigger} type="button" className="project-card-menu-trigger" aria-label={`Project options for ${project.title}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? `${id}-menu` : undefined} onClick={() => setMenuOpen(value => !value)} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMenuOpen(true); }
      }}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></svg></button>
      {menuOpen && <div className="project-card-menu" role="menu" id={`${id}-menu`} aria-label={`Actions for ${project.title}`} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); trigger.current?.focus(); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); menuItem.current?.focus(); }
        else if (event.key === "Tab") { setMenuOpen(false); trigger.current?.focus(); }
      }}><button ref={menuItem} type="button" role="menuitem" className="project-card-delete" onClick={openAction}><Icon name="trash" size={16} />Delete</button></div>}
    </> : <button ref={trigger} className="project-restore-button" type="button" onClick={openAction} disabled={pending}><Icon name="refresh" size={15} />{pending ? "Restoring…" : "Restore"}</button>}
    {dialogOpen && <dialog ref={dialog} className="project-lifecycle-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={busy} onCancel={event => { event.preventDefault(); closeDialog(); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog();
    }} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')).filter(element => element.tabIndex >= 0);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); dialogHeading.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogHeading.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <h2 id={`${id}-title`} ref={dialogHeading} tabIndex={-1}>{action === "delete" ? "Delete" : "Restore"} “{project.title}”{action === "delete" ? "?" : ""}</h2>
      <p id={`${id}-description`}>{action === "delete" ? "This moves the project to Deleted projects. Its assets and history are kept, and you can restore it any time." : "This returns the project to Projects with its assets and history."}</p>
      {pending && <p className="project-lifecycle-pending" role="status">{action === "delete" ? "Moving to Deleted projects…" : "Restoring project…"}</p>}
      {failure && <div className="project-lifecycle-error" role="alert"><p>{failure.message}</p>{failure.kind === "busy" && <Link className="text-link" href={`/brands/account/${project.id}`}>Open project</Link>}{refreshFailed && <p>Projects could not be refreshed. Check your connection and try again.</p>}</div>}
      <div className="project-lifecycle-buttons"><button ref={cancel} type="button" className="button secondary" disabled={busy} onClick={closeDialog}>{failure || action === "restore" ? "Close" : "Cancel"}</button>
        {failure ? <button type="button" className="button secondary" disabled={busy} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh projects"}</button> : action === "delete" && <button type="button" className="button project-delete-confirm" disabled={busy} onClick={() => void change(project, action)}>{pending ? "Moving project…" : "Delete project"}</button>}
      </div>
    </dialog>}
  </div>;
}
