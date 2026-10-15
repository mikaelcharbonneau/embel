"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountProjectPageSchema } from "@/domain/project-pages";
import { mergeProjectPage, type ProjectListing } from "./account-project-page-state";
import { Icon } from "@/components/ui/icon";
import { accountErrorMessage, accountRequest, AccountRequestError } from "./account-api";
import { StartReceiptRecoveryError, readReceipt, type StartReceipt } from "./account-project-start-recovery";
import { finishLocalDraftRecovery, saveLocalDraftToAccount } from "./save-local-draft-to-account";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { type LocalDraft } from "./local-drafts";

export function AccountCopyControl({ draft, onSaved }: { draft: LocalDraft; onSaved?: (projectId: string) => void }) {
  const { session, isCurrent, expire } = useAccountSession();
  const ownerId = session.status === "ready" ? session.userId : null;
  const identity = `${ownerId ?? "unverified"}:${session.generation}:${draft.id}`;
  const [operation, setOperation] = useState<{ identity: string; busy: boolean; error?: string; receipt?: StartReceipt | null } | null>(null);
  const [checkedRecovery, setCheckedRecovery] = useState<{ identity: string; receipt: StartReceipt | null; error?: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const router = useRouter();
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [identity]);
  useEffect(() => {
    if (!ownerId) return;
    let receipt: StartReceipt | null = null, error: string | undefined;
    try { receipt = readReceipt(ownerId, draft.id); }
    catch (cause) { error = cause instanceof StartReceiptRecoveryError ? cause.message : "Saved recovery records could not be verified. Check account projects before saving another copy."; }
    // Recover IDs only after a verified owner is available; this sends no request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCheckedRecovery({ identity, receipt, error });
  }, [draft.id, identity, ownerId]);
  const currentOperation = operation?.identity === identity ? operation : null;
  const recovery = checkedRecovery?.identity === identity ? checkedRecovery : null;
  const receipt = currentOperation?.receipt === undefined ? recovery?.receipt : currentOperation.receipt;
  const busy = Boolean(currentOperation?.busy);
  const uncertain = Boolean(receipt && !receipt.projectId);
  const unrecoverable = uncertain && !receipt?.request;
  const error = currentOperation?.error ?? recovery?.error;

  async function copy() {
    if (session.status !== "ready" || !isCurrent(session) || request.current || !recovery || recovery.error || unrecoverable) return;
    const account = session;
    const controller = new AbortController();
    request.current = controller;
    setOperation({ identity, busy: true, receipt });
    const current = () => !controller.signal.aborted && request.current === controller && isCurrent(account);
    let retained: StartReceipt | null = null;
    try {
      const saved = await saveLocalDraftToAccount({ account, draft, signal: controller.signal, isCurrent, expire, onReceipt: value => {
        retained = value;
        if (current()) setOperation({ identity, busy: true, receipt: value });
      } });
      if (!saved || !current() || !saved.receipt.projectId) return;
      setOperation({ identity, busy: false, receipt: saved.receipt });
      if (onSaved) onSaved(saved.receipt.projectId);
      else router.push(`/brands/account/${saved.receipt.projectId}`);
      finishLocalDraftRecovery(draft.id, account.userId, saved.receipt.projectId);
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setOperation({ identity, busy: false, receipt: retained, error: retained ? "The save is not confirmed. Your original project is kept; retry to check the same request." : cause instanceof StartReceiptRecoveryError ? cause.message : accountErrorMessage(cause) });
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted && isCurrent(account)) setOperation(previous => previous?.identity === identity ? { ...previous, busy: false } : previous);
      }
    }
  }

  if (draft.ownerId && draft.ownerId !== ownerId) return null;
  return <div className="account-copy-control"><div><strong>{receipt?.projectId ? "Project recovered" : "Save this project"}</strong><p>{session.status === "ready" ? receipt?.projectId ? "This project is saved in your account." : uncertain ? "The earlier account save is not confirmed. Your original project is kept." : "Save this project to your signed-in account. This does not start AI." : session.status === "checking" ? "Checking your account…" : "Sign in to save your project."}</p>{error && <p className="form-error" role="alert">{error}</p>}{(unrecoverable || recovery?.error) && <Link className="text-link" href="/brands">Check account projects</Link>}</div><button className="button secondary small" type="button" disabled={session.status !== "ready" || busy || !recovery || Boolean(recovery.error) || unrecoverable} onClick={() => void copy()}>{busy ? "Saving…" : receipt?.projectId ? "Open saved project" : uncertain ? "Check and retry save" : "Save project"}<Icon name="arrow" size={15} /></button></div>;
}

/** Callers must key their mounted library by owner and generation, hiding old rows immediately. */
export function useAccountProjectListing(account: VerifiedAccount | null) {
  const { isCurrent, expire } = useAccountSession();
  const [listing, setListing] = useState<ProjectListing | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const currentListing = useRef<ProjectListing | null>(null);
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const load = useCallback(async () => {
    if (!account || !active.current || !isCurrent(account) || request.current) return;
    const previous = currentListing.current;
    const cursor = previous?.nextCursor ?? null;
    if (previous && !cursor) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true); setError(false);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) { params.set("cursorCreatedAt", cursor.createdAt); params.set("cursorId", cursor.id); }
    try {
      const page = await accountRequest(`/api/projects/page?${params}`, accountProjectPageSchema, { signal: controller.signal });
      if (!account || !active.current || controller.signal.aborted || request.current !== controller || !isCurrent(account)) return;
      if (page.ownerId !== account.userId) { expire(account); return; }
      const next = mergeProjectPage(currentListing.current, page, cursor);
      currentListing.current = next; setListing(next);
    } catch (cause) {
      if (!account || !active.current || request.current !== controller || !isCurrent(account)) return;
      if (cause instanceof AccountRequestError && cause.status === 401) { expire(account); return; }
      setError(true);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        if (account && active.current && isCurrent(account)) setPending(false);
      }
    }
  }, [account, expire, isCurrent]);
  useEffect(() => {
    active.current = Boolean(account); void load();
    return () => { active.current = false; request.current?.abort(); request.current = null; };
  }, [account, load]);
  return { listing, error, pending, load };
}
