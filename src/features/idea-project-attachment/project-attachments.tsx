"use client";
import { ContextDetails } from "@/components/ui/context-details";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { createAccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import type { IdeaProjectAttachmentReceipt } from "@/domain/idea-project-attachment";
type Props = { account: VerifiedAccount; projectId: string };
export function ProjectIdeaAttachments(props: Props) { return <OwnedProjectIdeaAttachments key={`${props.account.userId}:${props.account.generation}:${props.projectId}`} {...props} />; }
function OwnedProjectIdeaAttachments({ account, projectId }: Props) {
 const { isCurrent, expire } = useAccountSession();
 const client = useMemo(() => createAccountLifecycleClient(account, isCurrent, expire), [account, isCurrent, expire]);
 const [items, setItems] = useState<IdeaProjectAttachmentReceipt[]>([]), [cursor, setCursor] = useState<string | null>(null), [loaded, setLoaded] = useState(false), [error, setError] = useState(false), [busy, setBusy] = useState(false);
 const active = useRef(false), request = useRef<AbortController | null>(null), seen = useRef(new Set<string>()), cursors = useRef(new Set<string>());
 const load = useCallback(async (next?: string) => {
  if (!active.current || !isCurrent(account) || request.current) return;
  const controller = new AbortController(); request.current = controller; setBusy(true); setError(false);
  try {
   const page = await client.getProjectIdeaAttachments(projectId, { ...(next ? { cursor: next } : {}), limit: 20 }, controller.signal);
   if (!page || !active.current || controller.signal.aborted || !isCurrent(account)) return;
   if (next && (cursors.current.has(next) || page.items.some(item => seen.current.has(item.association.id)))) throw new Error("Repeated attachment page");
   if (next) cursors.current.add(next); page.items.forEach(item => seen.current.add(item.association.id));
   setItems(previous => next ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor); setLoaded(true);
  } catch { if (active.current && isCurrent(account)) setError(true); }
  finally { if (request.current === controller) { request.current = null; if (active.current && isCurrent(account)) setBusy(false); } }
 }, [account, client, projectId, isCurrent]);
 useEffect(() => { active.current = true; seen.current = new Set(); cursors.current = new Set(); const task = setTimeout(() => void load(), 0); return () => { clearTimeout(task); active.current = false; request.current?.abort(); request.current = null; }; }, [load]);
 if (!isCurrent(account)) return null;
 return <section className="account-notice" aria-label="Attached Idea sources"><h2>Attached Ideas</h2>
  {items.map(item => <article key={item.association.id}><h3>{item.source.content.title}</h3><p>Frozen Idea version {item.association.ideaRevision}, attached at brand revision {item.association.projectRevision}.</p><p>{item.source.content.description}</p><ContextDetails  title={<>Saved Idea details</>}>{Object.entries(item.source.content.details).filter(([, text]) => text).map(([label, text]) => <p key={label}><strong>{label}:</strong> {text}</p>)}</ContextDetails><Link href={`/ideas/${item.association.ideaId}`}>Open current Idea</Link></article>)}
  {!loaded && !error && <p role="status">Loading saved Idea sources…</p>}{loaded && !items.length && <p>No Ideas attached to this brand.</p>}
  {error && <p className="form-error" role="alert">Idea sources could not be loaded. Any sources already shown are retained.</p>}
  {(cursor || error) && <button type="button" className="button secondary small" disabled={busy} onClick={() => void load(cursor ?? undefined)}>{busy ? "Loading…" : error ? "Retry source listing" : "Load more Idea sources"}</button>}
 </section>;
}
