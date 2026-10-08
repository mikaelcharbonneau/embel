"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ideaSourceResponseSchema, type IdeaSourceResponse } from "@/domain/ideas";
import { accountRequest, AccountRequestError } from "@/components/workspace/account-api";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { sameIdeaId } from "./ideas-client";
import "@/styles/ideas.css";

/** Mounted only after the account editor has verified its owned project. */
export function IdeaSourceBanner({ account, projectId }: { account: VerifiedAccount; projectId: string }) {
  const { isCurrent, expire } = useAccountSession();
  const [result, setResult] = useState<{ generation: number; projectId: string; source: IdeaSourceResponse["source"] } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!isCurrent(account)) return;
    let disposed = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => { if (!disposed && isCurrent(account)) setError(true); controller.abort(); }, 15_000);
    void accountRequest(`/api/projects/${projectId}/idea-source`, ideaSourceResponseSchema, { signal: controller.signal }).then(response => {
      if (disposed || controller.signal.aborted || !isCurrent(account)) return;
      if (!sameIdeaId(response.ownerId, account.userId) || !sameIdeaId(response.projectId, projectId)) { expire(account); return; }
      setResult({ generation: account.generation, projectId, source: response.source });
    }).catch(cause => {
      if (disposed || !isCurrent(account)) return;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setError(true);
    }).finally(() => window.clearTimeout(timeout));
    return () => { disposed = true; controller.abort(); window.clearTimeout(timeout); };
  }, [account, projectId, isCurrent, expire]);
  if (!isCurrent(account)) return null;
  if (error) return <p className="field-hint idea-source-unavailable">Original idea source is unavailable. You can keep editing this brand.</p>;
  if (!result || result.generation !== account.generation || result.projectId !== projectId || !result.source) return null;
  const { link, content } = result.source;
  return <section className="idea-source-banner" aria-label="Original idea"><div><span className="small-badge">Original idea</span><h2>{content.title}</h2><p>Source version {link.ideaRevision} · Frozen when this brand was created.</p></div><Link href={`/ideas/${link.ideaId}`} className="text-link">View original idea</Link></section>;
}
