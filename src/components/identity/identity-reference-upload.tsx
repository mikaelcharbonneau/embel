"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { identityReferenceUploadSchema } from "@/domain/identity-reference-uploads";
import { referenceElements, type IdentityReferenceEntry, type ReferenceElement } from "@/domain/identity-references";
import { createAccountIdentityClient } from "./account-identity-client";
import { createAccountLogoClient } from "./account-logo-client";
import type { IdentityReferenceUploadDraft } from "./identity-draft-memory";
import { referenceElementLabels } from "./reference-controls";
import { ContextDetails } from "@/components/ui/context-details";
import styles from "./identity-reference-upload.module.css";

/** Explicit owned uploads use the same verified raster publication as Logo.
 * Finishing a publication never chooses reference reactions for the customer. */
export function IdentityReferenceUpload({ account, projectId, blocked, onSaved }: { account: VerifiedAccount; projectId: string; blocked: boolean; onSaved(): void }) {
  const { isCurrent, expire, identityDrafts } = useAccountSession();
  const identity = useMemo(() => createAccountIdentityClient(account, projectId, isCurrent, expire), [account, projectId, isCurrent, expire]);
  const retained = useSyncExternalStore(identityDrafts.subscribe, () => identityDrafts.referenceUpload(account.userId, projectId), () => null);
  const active = useRef<AbortController | null>(null), form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null), [retry, setRetry] = useState<"upload" | "registration" | "rejected" | null>(null);
  const [elements, setElements] = useState<ReferenceElement[]>([]);
  useEffect(() => { identity.activate(); return () => { active.current?.abort(); identity.dispose(); }; }, [identity]);
  async function verify(entry: IdentityReferenceEntry, original: IdentityReferenceUploadDraft, signal: AbortSignal) {
    const digest = await crypto.subtle.digest("SHA-256", await original.file.arrayBuffer());
    const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    if (!identity.current()) return;
    if (signal.aborted) throw new Error("Reference request timed out");
    if (entry.reference.media.contentHash !== hash || entry.reference.media.mimeType !== original.file.type
      || JSON.stringify(entry.reference.attribution) !== JSON.stringify(original.input.metadata.attribution)
      || JSON.stringify(entry.reference.relevantElements) !== JSON.stringify(original.input.metadata.relevantElements)
      || JSON.stringify(entry.reference.tags) !== JSON.stringify(original.input.metadata.tags)) throw new Error("Reference receipt mismatch");
    identityDrafts.resolveReferenceUpload(account.userId, projectId, original.input.upload.requestKey);
    setRetry(null); setNotice("Reference saved. Choose Ensemble or individual elements to use it in your next system."); form.current?.reset(); setElements([]); onSaved();
  }
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (active.current || !identity.current()) return;
    const controller = new AbortController(); active.current = controller; const timeout = setTimeout(() => controller.abort(), 60_000);
    setBusy(true); setNotice(null); setRetry(null);
    try { await work(controller.signal); }
    catch { if (identity.current()) setNotice("The reference upload could not be confirmed. Your original file and attribution are kept here. Check the original upload before retrying."); }
    finally { clearTimeout(timeout); if (active.current === controller) { active.current = null; if (identity.current()) setBusy(false); } }
  }
  async function submit() {
    if (retained || blocked || !form.current) return;
    const data = new FormData(form.current), file = data.get("file");
    if (!(file instanceof File) || !file.size) return;
    const rights = String(data.get("rights") ?? "").trim();
    const metadata = { attribution: { label: String(data.get("label") ?? "").trim(), creator: String(data.get("creator") ?? "").trim() || null,
      sourceUrl: String(data.get("sourceUrl") ?? "").trim() || null, rightsNote: rights }, relevantElements: elements, tags: [] };
    await run(async signal => {
      const logo = createAccountLogoClient(account, projectId, isCurrent, expire);
      const workspace = await logo.getLogoWorkspace(signal).finally(() => logo.dispose()); if (!identity.current()) return; if (!workspace || signal.aborted) throw new Error("Workspace unavailable");
      const parsed = identityReferenceUploadSchema.safeParse({ upload: { requestKey: crypto.randomUUID(), expected: workspace.heads, aspects: ["overall_feel"], rightsDeclaration: rights }, metadata });
      if (!parsed.success) { setNotice("Check the attribution, source URL and permission declaration before uploading."); return; }
      const original = { ownerId: account.userId, projectId, input: parsed.data, file };
      if (!identityDrafts.retainReferenceUpload(original)) { setNotice("The file could not be retained safely. Use a PNG, JPEG or WebP up to 32 MiB and resolve pending uploads first."); return; }
      const entry = await identity.uploadReference(parsed.data, file, signal); if (!identity.current()) return; if (!entry || signal.aborted) throw new Error("Upload unconfirmed");
      await verify(entry, original, signal);
    });
  }
  async function check() {
    if (!retained) return;
    await run(async signal => {
      const found = await identity.referenceUpload(retained.input.upload.requestKey, signal); if (!identity.current()) return; if (!found || signal.aborted) throw new Error("Upload status unavailable");
      if (found.status === "registered") { await verify(found.entry, retained, signal); return; }
      const value = found.upload;
      if (value.status === "rejected") { setRetry("rejected"); setNotice("The upload was rejected because its saved inputs changed or it was cancelled. Your file and attribution are kept; you can discard this rejected upload and try again."); return; }
      if (value.status !== "not_found" && JSON.stringify(value.request.input) !== JSON.stringify(retained.input.upload)) throw new Error("Original upload mismatch");
      setRetry(value.status === "succeeded" ? "registration" : "upload");
      setNotice(value.status === "succeeded" ? "The verified file is saved. Finish adding its original attribution to Identity." : "The original upload has not completed. Retry the same file and request without creating another reference.");
    });
  }
  async function cancel() {
    if (!retained) return;
    await run(async signal => {
      const result = await identity.cancelReferenceUpload(retained.input, retained.file, signal);
      if (!identity.current()) return;
      if (!result || signal.aborted) throw new Error("Upload cancellation unconfirmed");
      if (result.status === "rejected") {
        identityDrafts.resolveReferenceUpload(account.userId, projectId, retained.input.upload.requestKey);
        setNotice("The original upload is cancelled. You can review the form and upload again using the latest saved project."); return;
      }
      if (result.status !== "succeeded") throw new Error("Upload cancellation not final");
      setRetry("registration"); setNotice("The file was already saved. Finish its original Identity reference registration; it has not been discarded.");
    });
  }
  return <ContextDetails title="Add your own reference"><form className={styles.form} ref={form} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p>Upload a PNG, JPEG or WebP you have permission to use, up to 32 MiB. Generation uses one to four selected images totaling 20 MiB or less. Attribution and permission are your declaration; they are not a verified license. External discovery remains unavailable.</p>
    <fieldset disabled={busy || Boolean(retained) || blocked}><label className={styles.field}>Reference image<input name="file" type="file" accept="image/png,image/jpeg,image/webp" required /></label>
      <label className={styles.field}>Reference title<input name="label" maxLength={240} required /></label><label className={styles.field}>Creator (optional)<input name="creator" maxLength={240} /></label>
      <label className={styles.field}>Source URL (optional)<input name="sourceUrl" type="url" maxLength={2048} /></label><label className={styles.field}>Permission declaration<textarea name="rights" maxLength={2000} required /></label>
      <label className={styles.permission}><input type="checkbox" required />Save the whole image as a reference</label><fieldset className={styles.elements}><legend>Relevant elements</legend><div className={styles.choices}>{referenceElements.map(element => <label key={element}><input type="checkbox" checked={elements.includes(element)} onChange={event => setElements(event.target.checked ? [...elements, element] : elements.filter(value => value !== element))} />{referenceElementLabels[element]}</label>)}</div></fieldset>
      <button type="submit" className="button secondary small">Upload reference</button></fieldset>
    {notice && <p role="status">{notice}</p>}
    {retained && <div className={styles.actions}><p>Pending upload: {retained.input.metadata.attribution.label}. Keep this page open to retain the original file.</p><button className="button secondary small" type="button" disabled={busy} onClick={() => void check()}>Check original upload</button><button className="button secondary small" type="button" disabled={busy} onClick={() => void cancel()}>Cancel original upload</button>
      {retry === "rejected" && <button type="button" disabled={busy} onClick={() => { identityDrafts.resolveReferenceUpload(account.userId, projectId, retained.input.upload.requestKey); setRetry(null); setNotice("The rejected upload has been discarded. Your saved references are unchanged."); }}>Discard rejected upload</button>}
      {retry && retry !== "rejected" && <button type="button" disabled={busy || blocked} onClick={() => void run(async signal => { const entry = await identity.uploadReference(retained.input, retry === "registration" ? null : retained.file, signal); if (entry) await verify(entry, retained, signal); })}>{retry === "registration" ? "Finish reference registration" : "Retry original upload"}</button>}</div>}
    {busy && <p role="status">Checking and saving your reference…</p>}
  </form></ContextDetails>;
}
