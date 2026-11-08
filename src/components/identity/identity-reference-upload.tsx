"use client";
import { useRef, useState } from "react";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { referenceElements, type ReferenceElement } from "@/domain/identity-references";
import { referenceElementLabels } from "./reference-controls";
import { useReferenceUpload } from "./use-reference-upload";
import { ContextDetails } from "@/components/ui/context-details";
import styles from "./identity-reference-upload.module.css";

/** The Identity references form: one image with its attribution and permission
 * declaration, saved through the shared verified upload (useReferenceUpload). */
export function IdentityReferenceUpload({ account, projectId, blocked, onSaved }: { account: VerifiedAccount; projectId: string; blocked: boolean; onSaved(): void }) {
  const upload = useReferenceUpload({ account, projectId, blocked, onSaved });
  const { retained, busy, notice, retry } = upload;
  const form = useRef<HTMLFormElement>(null), [elements, setElements] = useState<ReferenceElement[]>([]);
  async function submit() {
    if (!form.current) return;
    const data = new FormData(form.current), file = data.get("file");
    if (!(file instanceof File) || !file.size) return;
    const saved = await upload.upload(file, { label: String(data.get("label") ?? "").trim(), creator: String(data.get("creator") ?? "").trim() || null,
      sourceUrl: String(data.get("sourceUrl") ?? "").trim() || null, rightsNote: String(data.get("rights") ?? "").trim(), relevantElements: elements, tags: [] });
    if (saved) { form.current?.reset(); setElements([]); }
  }
  return <ContextDetails title="Add your own reference"><form className={styles.form} ref={form} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p>Upload a PNG, JPEG or WebP you have permission to use, up to 32 MiB. Generation uses one to four selected images totaling 20 MiB or less. Attribution and permission are your declaration; they are not a verified license. External discovery remains unavailable.</p>
    <fieldset disabled={busy || Boolean(retained) || blocked}><label className={styles.field}>Reference image<input name="file" type="file" accept="image/png,image/jpeg,image/webp" required /></label>
      <label className={styles.field}>Reference title<input name="label" maxLength={240} required /></label><label className={styles.field}>Creator (optional)<input name="creator" maxLength={240} /></label>
      <label className={styles.field}>Source URL (optional)<input name="sourceUrl" type="url" maxLength={2048} /></label><label className={styles.field}>Permission declaration<textarea name="rights" maxLength={2000} required /></label>
      <label className={styles.permission}><input type="checkbox" required />Save the whole image as a reference</label><fieldset className={styles.elements}><legend>Relevant elements</legend><div className={styles.choices}>{referenceElements.map(element => <label key={element}><input type="checkbox" checked={elements.includes(element)} onChange={event => setElements(event.target.checked ? [...elements, element] : elements.filter(value => value !== element))} />{referenceElementLabels[element]}</label>)}</div></fieldset>
      <button type="submit" className="button secondary small">Upload reference</button></fieldset>
    {notice && <p role="status">{notice}</p>}
    {retained && <div className={styles.actions}><p>Pending upload: {retained.input.metadata.attribution.label}. Keep this page open to retain the original file.</p><button className="button secondary small" type="button" disabled={busy} onClick={() => void upload.check()}>Check original upload</button><button className="button secondary small" type="button" disabled={busy} onClick={() => void upload.cancel()}>Cancel original upload</button>
      {retry === "rejected" && <button type="button" disabled={busy} onClick={upload.discardRejected}>Discard rejected upload</button>}
      {retry && retry !== "rejected" && <button type="button" disabled={busy || blocked} onClick={() => void upload.retryOriginal()}>{retry === "registration" ? "Finish reference registration" : "Retry original upload"}</button>}</div>}
    {busy && <p role="status">Checking and saving your reference…</p>}
  </form></ContextDetails>;
}
