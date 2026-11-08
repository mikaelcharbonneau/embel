"use client";

import { useEffect, useState } from "react";
import type { AccountLogoClient } from "../../../components/identity/account-logo-client";
import { AccountRequestError } from "../../../components/workspace/account-api";
import type { LogoVectorHistoryItem, LogoVectorHistoryPage } from "../model/history";
import styles from "./logo-vector.module.css";

type Read = { client: AccountLogoClient; cursor: string | undefined; page: LogoVectorHistoryPage | null; error: string | null };

/** Discovery is read only; the parent opens and verifies one immutable document
 * before its existing acceptance/restore controls can issue an explicit write. */
export function SavedVectorHistory({ client, workspaceRevision, current, disabled, onReview }: {
  client: AccountLogoClient; workspaceRevision: number; current(): boolean; disabled: boolean; onReview(item: LogoVectorHistoryItem): void;
}) {
  const [cursor, setCursor] = useState<string>(), [read, setRead] = useState<Read | null>(null);
  useEffect(() => {
    const controller = new AbortController(), active = () => !controller.signal.aborted && current();
    void client.listLogoVectorHistory({ cursor, limit: 20 }, controller.signal).then(page => {
      if (!active()) return;
      if (page && page.workspaceRevision !== workspaceRevision) throw new AccountRequestError(409);
      setRead({ client, cursor, page, error: null });
    }).catch(cause => {
      if (active()) setRead({ client, cursor, page: null, error: cause instanceof AccountRequestError && cause.status === 409
        ? "Your logo changed. Choose Refresh to see your saved vectors."
        : "Saved vectors could not be loaded. Choose Refresh to try again." });
    });
    return () => controller.abort();
  }, [client, current, cursor, workspaceRevision]);
  if (!current()) return null;
  const visible = read?.client === client && read.cursor === cursor ? read : null, page = visible?.page;
  return <section className={styles.history} aria-label="All saved vectors">
    <h3>All saved vectors</h3>
    <p className={styles.caption}>Includes completed conversions kept outside the current selection. Opening a vector does not select or accept it.</p>
    {!visible && <p role="status">Loading saved vectors…</p>}
    {visible?.error && <p role="status">{visible.error}</p>}
    {page && <><p className={styles.caption}>Selection and approval shown for workspace version {page.workspaceRevision}.</p>
      {page.items.length === 0 && <p>No saved vector candidates.</p>}
      <ol>{page.items.map(item => <li key={item.vectorRevisionId}>
        <div><strong>Vector {item.vectorRevisionId.slice(-8)}</strong><time dateTime={item.createdAt}>{item.createdAt}</time>
          <span className={styles.caption}>{item.selection === "current" ? "Current editing selection" : "Retained outside current selection"} · {item.acceptance === "approved" ? "Approved logo" : item.acceptance === "previously_accepted" ? "Previously accepted" : "Not accepted"}</span>
          <span className={styles.caption}>{item.source.kind === "concept" ? "From original concept" : "From refined preview"} · {item.lockCount} saved component {item.lockCount === 1 ? "lock" : "locks"}</span>
          {item.earlierInputs && <span className={styles.caption}>Earlier inputs need review</span>}
          {item.cancellation !== "none" && <span className={styles.caption}>{item.cancellation === "cancelled" ? "Cancelled conversion; completed vector retained" : "Conversion cancellation requested; completed vector retained"}</span>}
        </div>
        <button type="button" aria-label={`Open saved vector ${item.vectorRevisionId}`} disabled={disabled} onClick={() => onReview(item)}>Open vector</button>
      </li>)}</ol>
      {page.nextCursor && <button type="button" disabled={disabled} onClick={() => setCursor(page.nextCursor!)}>Earlier vector candidates</button>}
    </>}
    {cursor && <button type="button" disabled={disabled} onClick={() => setCursor(undefined)}>Latest vector candidates</button>}
  </section>;
}
