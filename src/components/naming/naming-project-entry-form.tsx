"use client";
import { useRouter } from "next/navigation";
import { useCallback, useSyncExternalStore, type FormEvent } from "react";
import { useAccountSession } from "@/components/workspace/account-session";
import { NamingRecoveryNotice } from "./naming-approach-widgets";
import { startNamingProject } from "./naming-project-entry";
const hidden = () => null;
export function NamingProjectEntryForm() {
  const router = useRouter();
  const { session, isCurrent, expire, namingBrainDrafts: memory } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const read = useCallback(() => account ? memory.getEntry(account) : null, [memory, account]);
  const draft = useSyncExternalStore(memory.subscribe, read, hidden);
  if (!account || !draft) return null;
  const patch = (fields: Partial<Pick<typeof draft, "description" | "direction">>) => memory.setEntry(account, value => ({ ...value, ...fields, error: null }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account || !isCurrent(account)) return;
    const projectId = await startNamingProject({ memory, account, expire: value => expire({ ...value, status: "ready" }) });
    if (projectId && isCurrent(account)) router.push(`/brands/account/${projectId}/naming`);
  }
  return <><NamingRecoveryNotice memory={memory} account={account} /><form onSubmit={event => void submit(event)} className="standalone-names-form" aria-label="Start Naming project">
    <label className="names-field">What are you naming?<textarea value={draft.description} required maxLength={3000} rows={4} disabled={Boolean(draft.input || draft.projectId)} placeholder="Describe the business, product or idea and who it is for." onChange={event => patch({ description: event.target.value })} /></label>
    <div className="standalone-names-fields"><label className="names-field">Anything else to consider?<textarea value={draft.direction} maxLength={1000} rows={2} disabled={Boolean(draft.input || draft.projectId)} placeholder="Optional preferences or words to avoid" onChange={event => patch({ direction: event.target.value })} /></label></div>
    <p className="names-muted">Your brief starts a saved Naming project. Answer a few naming questions there; suggestions will begin after your final response.</p>
    {draft.error ? <p className="form-error" role="alert">{draft.error}</p> : null}
    <button className="button primary" type="submit" disabled={draft.busy || !draft.description.trim()}>{draft.busy ? "Saving your project…" : draft.projectId ? "Open Naming project" : draft.input ? "Retry this project save" : "Continue to Naming"}</button>
    {draft.projectId ? <button type="button" className="button secondary" disabled={draft.busy} onClick={() => memory.startAnotherEntry(account)}>Start another brief</button> : null}
  </form></>;
}
