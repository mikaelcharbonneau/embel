"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { createAccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import type { StandalonePromotionSource } from "@/domain/standalone-promotion";
import { platforms } from "@/features/handles-workspace/domain";
import type { StandalonePromotionSnapshotResponse } from "./source-snapshot";

type Props = { account: VerifiedAccount; projectId: string; source: StandalonePromotionSource };
export function FrozenStandaloneSource(props: Props) {
 if (props.source.ownerId !== props.account.userId.toLowerCase()) return null;
 return <OwnedFrozenStandaloneSource key={`${props.account.userId}:${props.account.generation}:${props.projectId}:${props.source.id}`} {...props} />;
}
function OwnedFrozenStandaloneSource({ account, projectId, source }: Props) {
 const { isCurrent, expire } = useAccountSession();
 const client = useMemo(() => createAccountLifecycleClient(account, isCurrent, expire), [account, isCurrent, expire]);
 const [record, setRecord] = useState<StandalonePromotionSnapshotResponse | null>(null), [open, setOpen] = useState(false), [error, setError] = useState(false), [busy, setBusy] = useState(false);
 const active = useRef(false), request = useRef<AbortController | null>(null);
 useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, [account, client]);
 async function inspect() {
  if (!active.current || !isCurrent(account) || request.current) return;
  if (record) { setOpen(value => !value); return; }
  const controller = new AbortController(); request.current = controller; setBusy(true); setError(false); setOpen(true);
  try {
   const result = await client.getStandalonePromotionSnapshot(projectId, controller.signal);
   if (!result || !active.current || controller.signal.aborted || !isCurrent(account)) return;
   if (!result.source || !result.snapshot || JSON.stringify(result.source) !== JSON.stringify(source)) throw new Error("Frozen source mismatch");
   setRecord(result);
  } catch { if (active.current && isCurrent(account) && !controller.signal.aborted) setError(true); }
  finally { if (request.current === controller) { request.current = null; if (active.current && isCurrent(account)) setBusy(false); } }
 }
 if (!isCurrent(account)) return null;
 return <section className="account-notice" aria-label="Frozen standalone source">
  <button className="text-link" type="button" disabled={busy} aria-expanded={open} onClick={() => void inspect()}>{busy ? "Loading frozen source…" : record && open ? "Hide frozen source input" : "View frozen source input"}</button>
  {error && <p className="form-error" role="alert">The original saved input could not be verified. Current workspace edits have not been substituted.</p>}
  {open && record?.snapshot && <div aria-label="Frozen input details"><h3>Frozen {record.snapshot.payload.tool} version {record.snapshot.workspaceRevision}</h3><FrozenInput record={record} /></div>}
 </section>;
}
function Fields({ values }: { values: readonly (readonly [string, string])[] }) {
 return <dl>{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value || "Not supplied"}</dd></div>)}</dl>;
}
function FrozenInput({ record }: { record: StandalonePromotionSnapshotResponse }) {
 if (!record.source || !record.snapshot) return null;
 const payload = record.snapshot.payload, selection = record.source.selection;
 if (payload.tool === "domains") return <>
  <p>Availability was not checked. These are manually prepared domain candidates.</p>
  <Fields values={[["Selected candidate", selection.tool === "domains" ? selection.domain : ""], ["Original input", payload.data.input], ["Chosen extensions", payload.data.extensions.join(", ")]]} />
  <details><summary>All candidates in this saved input ({payload.data.candidates.length})</summary><ul>{payload.data.candidates.map(domain => <li key={domain}>{domain}</li>)}</ul></details>
 </>;
 if (payload.tool === "handles") {
  const selectedId = selection.tool === "handles" ? selection.bundleId : null;
  const bundle = payload.data.bundles.find(item => item.id === selectedId); if (!bundle) return null;
  return <><p>These are saved manual choices and account declarations. No platform verification or availability result is included.</p>
   <Fields values={[["Saved bundle", bundle.title], ["Saved list", bundle.list], ["User-supplied source label", bundle.source.name]]} />
   <ul>{bundle.entries.map(entry => <li key={entry.platform}><strong>{platforms.find(platform => platform.id === entry.platform)?.label}: @{entry.handle}</strong>{entry.favorite && <span> · Favorite</span>}{entry.selected && <span> · Selected</span>}
    {entry.accountCreated ? <p>Account creation declared by you on <time dateTime={entry.accountCreated.declaredAt}>{entry.accountCreated.declaredAt}</time>.{entry.accountCreated.url && <> Saved account URL: <span style={{ overflowWrap: "anywhere" }}>{entry.accountCreated.url}</span>.</>}</p> : <p>No account creation was declared.</p>}
   </li>)}</ul>
  </>;
 }
 const draft = payload.data;
 return <><p>This is a user-authored trademark draft. Its review marker does not establish clearance, registrability or filing readiness.</p>
  <Fields values={[["Mark name", draft.markName], ["Mark type", draft.markType], ["Representation notes", draft.representationNotes], ["Requested territories", draft.territories.join(", ")], ["Proposed owner", draft.owner.name], ["Owner address", draft.owner.address], ["Owner contact", draft.owner.contact], ["Goods and services", draft.goodsServices], ["Classification notes", draft.classificationNotes], ["Document plan", draft.documents.plan], ["Document notes", draft.documents.notes], ["User notes", draft.userNotes]]} />
  <p>{draft.reviewedContent === null ? "This saved draft was not marked reviewed." : "You marked this exact draft reviewed. This remains a manual draft acknowledgement."}</p>
 </>;
}
