"use client";

import type { IdentitySystemSummary } from "@/domain/project-identity";
import { BrowserLocalDate } from "@/components/workspace/browser-local-date";
import type { AccountIdentityClient } from "./account-identity-client";
import { IdentityFreshnessNotice, IdentitySystemBoard, identitySourceLabel } from "./identity-system-board";

export function IdentityHistory({ items, currentSystemId, viewedSystemId, client, pending, hasMore, loadingMore, onView, onMore }: {
  items: IdentitySystemSummary[]; currentSystemId: string | null; viewedSystemId: string | null; client: AccountIdentityClient;
  pending: boolean; hasMore: boolean; loadingMore: boolean; onView: (id: string) => void; onMore: () => void;
}) {
  return <section className="identity-history" aria-labelledby="identity-history-title"><div className="identity-section-heading"><h3 id="identity-history-title">Saved systems</h3><span>Immutable version history</span></div>
    {!items.length ? <p className="identity-empty">No Identity systems have been saved yet. Generation is unavailable.</p>
      : <div className="identity-history-grid">{items.map(system => <article className="identity-history-card" key={system.id} aria-label={`${system.name} ${identitySourceLabel(system.source)}`}>
        <IdentitySystemBoard board={system.board} name={system.name} client={client} />
        <div className="identity-history-content"><div className="identity-card-heading"><h4>{system.name}</h4>{currentSystemId === system.id && <span className="identity-badge">Current choice</span>}</div>
          <p>{identitySourceLabel(system.source)} · <BrowserLocalDate dateTime={system.createdAt} /></p>
          <IdentityFreshnessNotice freshness={system.freshness} />
          <button type="button" className="identity-secondary-button" disabled={pending} aria-pressed={viewedSystemId === system.id} onClick={() => onView(system.id)}>View system</button>
        </div>
      </article>)}</div>}
    {hasMore && <button type="button" className="identity-secondary-button identity-more" disabled={pending || loadingMore} onClick={onMore}>{loadingMore ? "Loading history…" : "Load more systems"}</button>}
  </section>;
}
