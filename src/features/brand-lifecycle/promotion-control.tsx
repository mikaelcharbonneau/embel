"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { createAccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import { accountErrorMessage, AccountRequestError } from "@/components/workspace/account-api";
import type { DomainDraft } from "@/features/domain-workspace/draft";
import type { HandlesState } from "@/features/handles-workspace/domain";
import type { TrademarkDraft } from "@/features/trademark-workspace/domain";
import { standaloneImportKey, type StandaloneWorkspace } from "@/domain/standalone-workspaces";
import type { StandalonePromotionSelection, StandalonePromotionReceipt } from "@/domain/standalone-promotion";
import type { LifecycleIntentMemory } from "./intent-memory";
import { executeLifecycleIntent } from "./execute-intent";
export type StandalonePromotionControlProps = { account: VerifiedAccount; workspace: StandaloneWorkspace<DomainDraft | HandlesState | TrademarkDraft>; selection: StandalonePromotionSelection; dirty: boolean; pending: boolean; memory: LifecycleIntentMemory; onCreated(receipt: StandalonePromotionReceipt): void };
const empty = () => null;
export function StandalonePromotionControl(props: StandalonePromotionControlProps) { return <OwnedStandalonePromotionControl key={`${props.account.userId}:${props.account.generation}:${props.workspace.id}:${JSON.stringify(props.selection)}`} {...props} />; }
function OwnedStandalonePromotionControl({ account, workspace, selection, dirty, pending, memory, onCreated }: StandalonePromotionControlProps) {
 const { isCurrent, expire } = useAccountSession(), id = useId();
 const client = useMemo(() => createAccountLifecycleClient(account, isCurrent, expire), [account, isCurrent, expire]);
 const read = useCallback(() => memory.get(account, "standalone_promotion"), [memory, account]);
 const saved = useSyncExternalStore(memory.subscribe, read, empty), intent = saved?.kind === "standalone_promotion" ? saved : null;
 const [title, setTitle] = useState(""), [contextKey, setContextKey] = useState<string>(workspace.imports.length === 1 ? standaloneImportKey(workspace.imports[0]!) : workspace.imports.length ? "" : "none");
 const [engagedKey, setEngagedKey] = useState<string | null>(null);
 const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
 const active = useRef(false), request = useRef<AbortController | null>(null);
 useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, [account]);
 const unresolved = intent && intent.outcome !== "confirmed";
 const confirmedSelection = intent?.outcome === "confirmed" && intent.input.workspaceId === workspace.id && (intent.input.expectedWorkspaceRevision === workspace.revision || engagedKey === intent.input.requestKey) && JSON.stringify(intent.input.selection) === JSON.stringify(selection);
 const shownSelection = unresolved || confirmedSelection ? intent!.input.selection : selection;
 const shownRevision = unresolved || confirmedSelection ? intent!.input.expectedWorkspaceRevision : workspace.revision;
 async function promote() {
  if (!active.current || !isCurrent(account) || dirty || pending || request.current) return;
  const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
  try {
   const existing = memory.get(account, "standalone_promotion");
   if (existing?.kind === "standalone_promotion" && existing.outcome === "confirmed" && existing.receipt && existing.input.workspaceId === workspace.id && (existing.input.expectedWorkspaceRevision === workspace.revision || engagedKey === existing.input.requestKey) && JSON.stringify(existing.input.selection) === JSON.stringify(selection)) { onCreated(existing.receipt); return; }
   const recover = existing?.kind === "standalone_promotion" && existing.outcome !== "confirmed";
   const source = workspace.imports.find(source => standaloneImportKey(source) === contextKey);
   if (!recover && (!title.trim() || (!source && contextKey !== "none"))) { setError("Add a brand title and choose which saved context to carry forward."); return; }
   const current = recover ? existing : { kind: "standalone_promotion" as const, input: { requestKey: crypto.randomUUID(), workspaceId: workspace.id, expectedWorkspaceRevision: workspace.revision, selection, contextSource: source ? { projectId: source.projectId, projectRevision: source.projectRevision, selectionId: source.selectionId } : null, title: title.trim() }, receipt: null, outcome: "pending" as const };
   if (!current) return;
   setEngagedKey(current.input.requestKey);
   const result = await executeLifecycleIntent({ account, memory, client, intent: current, signal: controller.signal, recover });
   if (result?.kind === "standalone_promotion" && result.receipt && active.current && !controller.signal.aborted && isCurrent(account)) onCreated(result.receipt);
  } catch (cause) { if (active.current && isCurrent(account)) setError(cause instanceof AccountRequestError && cause.status === 409 ? "The saved workspace changed. The original promotion request is retained for checking, with its original source." : accountErrorMessage(cause)); }
  finally { if (request.current === controller) { request.current = null; if (active.current && isCurrent(account)) setBusy(false); } }
 }
 if (!isCurrent(account) || workspace.ownerId !== account.userId.toLowerCase() || workspace.tool !== selection.tool) return null;
 return <section className="account-copy-control" aria-label="Create complete brand from saved work"><div>
  <h2>Create brand from saved work</h2><p className="field-hint">Saved {shownSelection.tool} version {shownRevision}. Existing context is kept; missing Strategy can be completed in the new brand.</p>
  <p className="field-hint">Selected source: {shownSelection.tool === "domains" ? shownSelection.domain : shownSelection.tool === "handles" ? `handle bundle ${shownSelection.bundleId}` : "saved trademark draft"}.</p>
  <label className="field-label" htmlFor={`${id}-title`}>New brand title</label><input id={`${id}-title`} value={unresolved || confirmedSelection ? intent!.input.title : title} maxLength={160} disabled={busy || !!unresolved || confirmedSelection} onChange={event => setTitle(event.target.value)} />
  {!unresolved && !confirmedSelection && workspace.imports.length > 0 && <><label className="field-label" htmlFor={`${id}-context`}>Saved context to carry forward</label><select id={`${id}-context`} value={contextKey} disabled={busy} onChange={event => setContextKey(event.target.value)}><option value="">Choose saved context</option><option value="none">Use this tool’s manual input only</option>{workspace.imports.map(source => <option key={standaloneImportKey(source)} value={standaloneImportKey(source)}>{source.projectTitle}, version {source.projectRevision}: {source.name}</option>)}</select></>}
  <p className="field-hint">Domain availability stays unchecked. Social accounts remain user-declared. Trademark notes do not establish clearance.</p>
  {dirty && <p>Save the workspace changes before creating a brand.</p>}
  {unresolved && <p role="status">The original promotion is awaiting confirmation. Its title, selection and source versions stay fixed.</p>}
  <button className="button secondary small" type="button" disabled={busy || dirty || pending || (!unresolved && !confirmedSelection && (!title.trim() || !contextKey))} onClick={() => void promote()}>{busy ? "Checking brand creation…" : unresolved ? "Check and retry original promotion" : confirmedSelection ? "Open created brand" : "Create complete brand"}</button>
  {error && <p className="form-error" role="alert">{error}</p>}
  {intent?.receipt && <p role="status">Brand created. <Link href={`/brands/account/${intent.receipt.project.id}`}>Open {intent.receipt.project.title}</Link></p>}
 </div></section>;
}
