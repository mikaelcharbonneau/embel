"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { accountProjectPageSchema } from "@/domain/project-pages";
import { accountRequest, AccountRequestError } from "@/components/workspace/account-api";
import { mergeProjectPage, type ProjectListing } from "@/components/workspace/account-project-page-state";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";

export type StandaloneProjectSelection = { id: string; title: string };
type Props = { selectedProjectId?: string; onSelect: (project: StandaloneProjectSelection | null) => void };

/** Selecting a saved source never imports its content or changes a tool draft. */
export function StandaloneProjectPicker(props: Props) {
  const { session } = useAccountSession();
  if (session.status !== "ready") return null;
  return <OwnedProjectPicker key={`${session.userId}:${session.generation}`} account={session} {...props} />;
}

function OwnedProjectPicker({ account, selectedProjectId, onSelect }: Props & { account: VerifiedAccount }) {
  const { isCurrent, expire } = useAccountSession();
  const selectId = useId();
  const [listing, setListing] = useState<ProjectListing | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const currentListing = useRef<ProjectListing | null>(null);
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);

  const load = useCallback(async () => {
    if (!active.current || !isCurrent(account) || request.current) return;
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
      if (!active.current || controller.signal.aborted || request.current !== controller || !isCurrent(account)) return;
      if (page.ownerId !== account.userId) { expire(account); return; }
      const next = mergeProjectPage(currentListing.current, page, cursor);
      currentListing.current = next;
      setListing(next);
    } catch (cause) {
      if (!active.current || request.current !== controller || !isCurrent(account)) return;
      if (cause instanceof AccountRequestError && cause.status === 401) { expire(account); return; }
      setError(true);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        if (active.current && isCurrent(account)) setPending(false);
      }
    }
  }, [account, expire, isCurrent]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; request.current?.abort(); request.current = null; };
  }, [load]);

  return <section className="account-copy-control" aria-label="Import from a saved project">
    <div style={{ minWidth: 0, width: "100%" }}>
      <label className="field-label" htmlFor={selectId}>Saved project for import</label>
      <select id={selectId} style={{ maxWidth: "100%", width: "100%" }} value={selectedProjectId ?? ""} disabled={!listing?.items.length} onChange={event => {
        if (!active.current || !isCurrent(account)) return;
        const selected = listing?.items.find(project => project.id === event.target.value);
        onSelect(selected ? { id: selected.id, title: selected.title } : null);
      }}>
        <option value="">Choose a saved project</option>
        {listing?.items.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>
      <p className="field-hint">Choose a project, then choose Import saved name.</p>
      {listing && <p className="field-hint">{listing.items.length} saved {listing.items.length === 1 ? "project" : "projects"} loaded.{listing.nextCursor ? " Load more to find older projects." : " End of this listing."}</p>}
      {!listing && !error && <p role="status">Loading saved projects…</p>}
      {listing && listing.items.length === 0 && <p>No saved projects yet. Save a brand to your account to import from it.</p>}
      {error && <div className="form-error" role="alert"><p>Saved projects could not be loaded.{listing ? " Your loaded projects are still available." : ""}</p><button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>Try loading saved projects again</button></div>}
    </div>
    {listing?.nextCursor && !error && <button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>{pending ? "Loading more saved projects…" : "Load more saved projects"}</button>}
  </section>;
}
