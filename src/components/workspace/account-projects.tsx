"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountProjectResponseSchema } from "@/domain/project-api";
import { accountProjectPageSchema } from "@/domain/project-pages";
import { mergeProjectPage, type ProjectListing } from "./account-project-page-state";
import { Icon } from "@/components/ui/icon";
import { accountErrorMessage, accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { createAccountInput, draftValidationMessage } from "./project-draft-adapter";
import { type LocalDraft } from "./local-drafts";

export function AccountCopyControl({ draft }: { draft: LocalDraft }) {
  const { session, isCurrent, expire } = useAccountSession();
  const [operation, setOperation] = useState<{ generation: number; busy: boolean; error?: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const router = useRouter();
  useEffect(() => () => request.current?.abort(), [session.generation]);
  const busy = operation?.generation === session.generation && operation.busy;

  async function copy() {
    if (session.status !== "ready" || !isCurrent(session) || busy) return;
    let input;
    try { input = createAccountInput(draft); }
    catch { setOperation({ generation: session.generation, busy: false, error: draftValidationMessage(draft) }); return; }
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setOperation({ generation: session.generation, busy: true });
    try {
      const { project } = await accountRequest("/api/projects", accountProjectResponseSchema, { method: "POST", body: input, signal: controller.signal });
      if (controller.signal.aborted || !isCurrent(session)) return;
      if (project.owner_id !== session.userId) { expire(session); return; }
      router.push(`/brands/account/${project.id}`);
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(session)) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(session);
      else setOperation({ generation: session.generation, busy: false, error: accountErrorMessage(error) });
    }
  }

  return <div className="account-copy-control"><div><strong>Keep a copy in your account</strong><p>{session.status === "ready" ? "Your browser draft stays here when you save an account copy." : session.status === "checking" ? "Checking your account…" : "Account saving is unavailable until a verified session is connected."}</p>{operation?.generation === session.generation && operation.error && <p className="form-error" role="alert">{operation.error}</p>}</div><button className="button secondary small" type="button" disabled={session.status !== "ready" || busy} onClick={() => void copy()}>{busy ? "Saving copy…" : "Save to account"}<Icon name="arrow" size={15} /></button></div>;
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
