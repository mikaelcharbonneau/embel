"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountProjectResponseSchema, accountSessionSchema } from "@/domain/project-api";
import { accountProjectPageSchema } from "@/domain/project-pages";
import { mergeProjectPage, type ProjectListing } from "./account-project-page-state";
import { Icon } from "@/components/ui/icon";
import { accountErrorMessage, accountRequest, AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";
import { StartReceiptRecoveryError, readReceipt, rememberReceipt, forgetReceipt, type StartReceipt } from "./account-project-start-recovery";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { createAccountInput, draftValidationMessage } from "./project-draft-adapter";
import { type LocalDraft } from "./local-drafts";

export function AccountCopyControl({ draft }: { draft: LocalDraft }) {
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
  const error = currentOperation?.error ?? recovery?.error;

  async function copy() {
    if (session.status !== "ready" || !isCurrent(session) || request.current || !recovery || recovery.error || uncertain) return;
    const account = session;
    const controller = new AbortController();
    request.current = controller;
    setOperation({ identity, busy: true, receipt });
    const current = () => !controller.signal.aborted && request.current === controller && isCurrent(account);
    let retained: StartReceipt | null = null;
    try {
      const { user } = await boundedAccountRequest("/api/session", accountSessionSchema, { signal: controller.signal });
      if (!current()) return;
      if (user.id !== account.userId) { expire(account); return; }
      // Recheck after the session read: Home or another mounted copy control may
      // already have recorded this non-idempotent create while it was pending.
      retained = readReceipt(account.userId, draft.id);
      if (retained) {
        setOperation({ identity, busy: false, receipt: retained });
        if (retained.projectId) router.push(`/brands/account/${retained.projectId}`);
        return;
      }
      let input;
      try { input = createAccountInput(draft); }
      catch { setOperation({ identity, busy: false, error: draftValidationMessage(draft) }); return; }
      const pendingReceipt = { ownerId: account.userId, draftId: draft.id, projectId: null };
      rememberReceipt(pendingReceipt); retained = pendingReceipt;
      setOperation({ identity, busy: true, receipt: retained });
      let project;
      try {
        ({ project } = await boundedAccountRequest("/api/projects", accountProjectResponseSchema, { method: "POST", body: input, signal: controller.signal }));
      } catch (cause) {
        if (cause instanceof AccountRequestError && [400, 401, 403, 413, 422, 429].includes(cause.status)) {
          forgetReceipt(retained); retained = null;
        }
        throw cause;
      }
      if (!current()) return;
      if (project.owner_id !== account.userId) { expire(account); return; }
      if (project.current_revision !== 1 || project.scope !== input.scope || project.title !== input.title || JSON.stringify(project.context) !== JSON.stringify(input.context)) throw new AccountRequestError(502);
      retained = { ...retained, projectId: project.id }; rememberReceipt(retained);
      setOperation({ identity, busy: false, receipt: retained });
      router.push(`/brands/account/${project.id}`);
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setOperation({ identity, busy: false, receipt: retained, error: retained ? "The account save is not confirmed. Check account projects before saving another copy. Your browser draft is kept." : cause instanceof StartReceiptRecoveryError ? cause.message : accountErrorMessage(cause) });
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted && isCurrent(account)) setOperation(previous => previous?.identity === identity ? { ...previous, busy: false } : previous);
      }
    }
  }

  return <div className="account-copy-control"><div><strong>Keep a copy in your account</strong><p>{session.status === "ready" ? receipt?.projectId ? "An account copy is already saved. Your browser draft remains independent." : uncertain ? "The earlier account save is not confirmed. Your browser draft is kept." : "Your browser draft stays here when you save an account copy." : session.status === "checking" ? "Checking your account…" : "Account saving is unavailable until a verified session is connected."}</p>{error && <p className="form-error" role="alert">{error}</p>}{(uncertain || recovery?.error) && <Link className="text-link" href="/brands">Check account projects</Link>}</div><button className="button secondary small" type="button" disabled={session.status !== "ready" || busy || !recovery || Boolean(recovery.error) || uncertain} onClick={() => void copy()}>{busy ? "Saving copy…" : receipt?.projectId ? "Open saved account project" : "Save to account"}<Icon name="arrow" size={15} /></button></div>;
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
