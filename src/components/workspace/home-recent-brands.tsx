"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { accountProjectPageSchema, type AccountProjectPage } from "@/domain/project-pages";
import { accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession } from "./account-session";
import { draftTitle, useLocalDrafts, type LocalDraft } from "./local-drafts";

function savedStage(draft: LocalDraft) {
  const labels = { positioning: "positioning", personality: "personality", audience: "audience", competitors: "competitors", description: "your brief", review: "your brief" };
  return `Continue ${labels[draft.stage]}`;
}

export function HomeRecentBrands() {
  const { drafts, loaded } = useLocalDrafts();
  const { session, isCurrent, expire } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const fence = account ? `${account.userId}:${account.generation}` : null;
  const [result, setResult] = useState<{ fence: string; page?: AccountProjectPage; error?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!account || !fence) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); if (isCurrent(account)) setResult({ fence, error: true }); }, 15_000);
    void accountRequest("/api/projects/page?limit=6", accountProjectPageSchema, { signal: controller.signal }).then(page => {
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (page.ownerId !== account.userId) { expire(account); return; }
      setResult({ fence, page });
    }).catch(error => {
      if (!isCurrent(account)) return;
      if (error instanceof AccountRequestError && error.status === 401) { expire(account); return; }
      // An aborted unmount cannot republish private data. Timeout failures carry no data.
      if (!controller.signal.aborted) setResult({ fence, error: true });
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [account, fence, isCurrent, expire, retry]);
  const current = result?.fence === fence ? result : null;
  const brands = [
    ...drafts.map(draft => ({ key: `browser:${draft.id}`, title: draftTitle(draft), href: `/brands/${draft.id}`, storage: "Browser draft", local: true, stage: savedStage(draft), time: draft.updatedAt })),
    ...(current?.page?.items ?? []).map(project => ({ key: `account:${project.id}`, title: project.title, href: `/brands/account/${project.id}`, storage: "Account project", local: false, stage: "Continue your brand", time: project.created_at })),
  ].sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.key.localeCompare(b.key)).slice(0, 6);

  return <section className="home-recent" aria-labelledby="recent-heading">
    <div className="home-recent-heading"><h2 id="recent-heading">Pick up where you left off</h2><Link href="/brands" className="text-link">All projects<Icon name="arrow" size={16} /></Link></div>
    {!loaded ? <p className="quiet-empty" role="status">Loading your brands…</p> : brands.length ? <div className="home-brand-grid">
      {brands.map((brand, index) => <Link key={brand.key} href={brand.href} className="home-brand-card">
        <div className={`home-brand-preview home-brand-preview--${index === 1 ? "1" : index === 2 ? "2" : index === 4 ? "inverse" : "0"}`} aria-hidden="true"><span>{brand.title}</span></div>
        <div className="home-brand-details"><div className="home-brand-identity"><h3>{brand.title}</h3><span className="home-brand-storage">{brand.local && <Icon name="device" size={13} />}{brand.storage}</span></div>
          <div className="home-brand-continue"><span>{brand.stage}</span><Icon name="arrow" size={16} /></div>
        </div>
      </Link>)}
    </div> : <div className="home-brands-empty"><Icon name="brands" size={24} /><h3>Your first brand starts here</h3><p>Describe your idea above. Your saved work will appear here.</p></div>}
    {account && !current && <p className="field-hint" role="status">Loading account brands…</p>}
    {current?.error && <p className="form-error" role="alert">Account brands could not be loaded. <button type="button" className="text-link" onClick={() => setRetry(value => value + 1)}>Try again</button></p>}
  </section>;
}
