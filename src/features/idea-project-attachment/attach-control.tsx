"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { IdeaRecord } from "@/domain/ideas";
import { StandaloneProjectPicker, type StandaloneProjectSelection } from "@/components/tools/standalone-project-picker";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { accountErrorMessage, AccountRequestError } from "@/components/workspace/account-api";
import { createAccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import type { LifecycleIntentMemory } from "@/features/brand-lifecycle/intent-memory";
import { executeLifecycleIntent } from "@/features/brand-lifecycle/execute-intent";
export type AttachIdeaControlProps = { account: VerifiedAccount; idea: IdeaRecord; dirty: boolean; pending: boolean; memory: LifecycleIntentMemory };
const empty = () => null;
export function AttachIdeaControl(props: AttachIdeaControlProps) { return <OwnedAttachIdeaControl key={`${props.account.userId}:${props.account.generation}:${props.idea.id}`} {...props} />; }
function OwnedAttachIdeaControl({ account, idea, dirty, pending, memory }: AttachIdeaControlProps) {
 const { isCurrent, expire } = useAccountSession();
 const client = useMemo(() => createAccountLifecycleClient(account, isCurrent, expire), [account, isCurrent, expire]);
 const read = useCallback(() => memory.get(account, "idea_attachment"), [memory, account]);
 const saved = useSyncExternalStore(memory.subscribe, read, empty);
 const intent = saved?.kind === "idea_attachment" ? saved : null;
 const [selected, setSelected] = useState<StandaloneProjectSelection | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
 const request = useRef<AbortController | null>(null), active = useRef(false);
 useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, [account]);
 async function attach() {
  if (!active.current || !isCurrent(account) || dirty || pending || request.current || (intent && intent.outcome !== "confirmed" && intent.input.ideaId !== idea.id)) return;
  const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
  try {
   let current = memory.get(account, "idea_attachment");
   if (current?.kind === "idea_attachment" && current.outcome === "confirmed" && current.input.ideaId === idea.id && current.input.expectedIdeaRevision === idea.revision && current.input.projectId === selected?.id) return;
   const recover = current?.kind === "idea_attachment" && current.outcome !== "confirmed";
   if (!recover) {
    if (!selected) return;
    const project = await client.getProject(selected.id, controller.signal);
    if (!project || controller.signal.aborted || !active.current || !isCurrent(account)) return;
    current = { kind: "idea_attachment", input: { requestKey: crypto.randomUUID(), ideaId: idea.id, expectedIdeaRevision: idea.revision, projectId: project.project.id, expectedProjectRevision: project.project.current_revision }, outcome: "pending", receipt: null };
   }
   if (!current) return;
   await executeLifecycleIntent({ account, memory, client, intent: current, signal: controller.signal, recover });
  } catch (cause) { if (active.current && isCurrent(account)) setError(cause instanceof AccountRequestError && cause.status === 409 ? "The saved Idea or brand changed. Your original attachment request is retained for checking; no later edits were substituted." : accountErrorMessage(cause)); }
  finally { if (request.current === controller) { request.current = null; if (active.current && isCurrent(account)) setBusy(false); } }
 }
 if (!isCurrent(account) || idea.ownerId.toLowerCase() !== account.userId.toLowerCase()) return null;
 const unresolved = intent && intent.outcome !== "confirmed";
 const currentIdea = !intent || intent.input.ideaId === idea.id;
 const otherPendingIdea = Boolean(unresolved && !currentIdea);
 const alreadyAttached = intent?.outcome === "confirmed" && intent.input.ideaId === idea.id && intent.input.expectedIdeaRevision === idea.revision && intent.input.projectId === selected?.id;
 return <section className="account-copy-control" aria-label="Attach saved Idea to a brand"><div>
  <h2>Attach to an existing brand</h2><p className="field-hint">Keeps this saved Idea version as a source. Your brand’s existing Strategy stays as saved.</p>
  {!unresolved && <StandaloneProjectPicker selectedProjectId={selected?.id} onSelect={setSelected} />}
  {unresolved && <p role="status">An attachment request is awaiting confirmation. Its saved source and target are kept. {!currentIdea && <Link href={`/ideas/${intent.input.ideaId}`}>Open that Idea to recover it</Link>}</p>}
  {dirty && <p>Save your Idea edits before attaching.</p>}
  <button className="button secondary small" type="button" disabled={dirty || pending || busy || alreadyAttached || otherPendingIdea || (!unresolved && !selected)} onClick={() => void attach()}>{busy ? "Checking attachment…" : unresolved ? "Check and retry original attachment" : alreadyAttached ? "Attached to brand" : "Attach to brand"}</button>
  {error && <p className="form-error" role="alert">{error}</p>}
  {intent?.outcome === "confirmed" && currentIdea && <p role="status">{intent.receipt?.status === "already_attached" ? <>Idea version {intent.input.expectedIdeaRevision} is already attached at brand revision {intent.receipt.attachment.association.projectRevision}.</> : <>Idea version {intent.input.expectedIdeaRevision} attached.</>} <Link href={`/brands/account/${intent.input.projectId}`}>Open brand</Link></p>}
 </div></section>;
}
