"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { emptyLogoInputDraft, type LogoInputDraft, type LogoInputSession } from "../client/session";
import { logoReferenceAspectSchema, type LogoReferenceRegistration, type LogoReferenceSelection, type LogoReferenceSnapshot, type LogoWorkspaceV2 } from "@/domain/logo-workspace";
import { REFERENCE_ASPECT_LABELS } from "@/components/logo-creation/presentation";
import { fontPurposeAllowed } from "@/features/identity-directions/model/font-rights";
import { REFERENCE_PERMISSION, FONT_PERMISSION, type LogoInputClient, type LogoInputsController, type InputPreview } from "../client/controller";
import { CURATED_REFERENCE_UNAVAILABLE, UPLOADED_FONT_REVIEW_NOTICE } from "../model/contracts";
import styles from "./logo-inputs.module.css";

const EMPTY_DRAFT = Object.freeze(emptyLogoInputDraft()), noSubscription = () => () => undefined;
export type LogoInputsPanelProps = {
  session: LogoInputSession; account: VerifiedAccount;
  client: LogoInputClient; workspace: LogoWorkspaceV2; bindingKey: string; isCurrent(): boolean; canWrite: boolean;
  mode?: "references" | "fonts" | "all"; selections?: readonly LogoReferenceSelection[];
  savedReferences?: LogoReferenceSnapshot["references"]; onSelectionsChange?(selections: LogoReferenceSelection[]): void;
  onUnsavedChange?(unsaved: boolean): void;
};
/** Key by verified account generation as well as owner/project. Controller and
 * file bytes never enter a singleton, localStorage or the saved brand JSON. */
export function LogoInputsPanel(props: LogoInputsPanelProps): React.JSX.Element {
  if (!props.isCurrent()) return <p role="status">Sign in to view your saved inputs.</p>;
  return <OwnedLogoInputs key={`${props.bindingKey}:${props.workspace.ownerId}:${props.workspace.projectId}`} {...props} />;
}
function OwnedLogoInputs(props: LogoInputsPanelProps): React.JSX.Element {
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });
  const [controller, setController] = useState<LogoInputsController | null>(null);
  const ownerId = props.workspace.ownerId, projectId = props.workspace.projectId;
  useLayoutEffect(() => {
    if (props.session && props.account) props.session.connect(props.account, props.workspace, props.client, props.canWrite);
  }, [props.session, props.account, props.workspace, props.client, props.canWrite]);
  useEffect(() => {
    const registry = latest.current.session, account = latest.current.account;
    const next = registry.connect(account, latest.current.workspace, props.client, latest.current.canWrite);
    // Registry controllers outlive the view; unmount removes only React subscriptions.
    setController(next); if (next) void next.refresh();
  }, [ownerId, projectId, props.client, props.bindingKey, props.session]);
  return controller ? <LogoInputsView {...props} controller={controller} /> : <p role="status">Loading saved inputs…</p>;
}
export function LogoInputsView({ controller, client, canWrite, isCurrent, mode = "all", selections = [], savedReferences = [], onSelectionsChange, onUnsavedChange, workspace, session, account }: {
  session?: LogoInputSession; account?: VerifiedAccount;
  controller: LogoInputsController; client: LogoInputClient; canWrite: boolean; isCurrent(): boolean; mode?: "references" | "fonts" | "all";
  selections?: readonly LogoReferenceSelection[]; savedReferences?: LogoReferenceSnapshot["references"]; workspace?: LogoWorkspaceV2;
  onSelectionsChange?(selections: LogoReferenceSelection[]): void; onUnsavedChange?(unsaved: boolean): void;
}): React.JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot), title = useId();
  const [localDraft, setLocalDraft] = useState<LogoInputDraft>(emptyLogoInputDraft), localDraftRef = useRef(localDraft);
  const [draftError, setDraftError] = useState<string | null>(null);
  useLayoutEffect(() => { localDraftRef.current = localDraft; }, [localDraft]);
  const storedDraft = useSyncExternalStore(session?.subscribe ?? noSubscription,
    () => session && account && workspace ? session.getDraft(account, workspace.projectId) ?? EMPTY_DRAFT : EMPTY_DRAFT, () => EMPTY_DRAFT);
  const draft = session ? storedDraft : localDraft;
  const { referenceFile, referencePermission, aspects, fontFile, fontPermission, license, licenseUrl } = draft;
  function changeDraft(patch: Partial<LogoInputDraft>) {
    const prior = session && account && workspace ? session.getDraft(account, workspace.projectId) : localDraftRef.current;
    if (!prior || !isCurrent()) return;
    const next = { ...prior, ...patch };
    if (session && account && workspace) {
      if (!session.setDraft(account, workspace.projectId, next)) { setDraftError("This selection exceeds the supported input limits. Your previous input is kept."); return; }
    } else { localDraftRef.current = next; setLocalDraft(next); }
    setDraftError(null);
    // Synchronous notification precedes React effects and any async file hashing.
    onUnsavedChange?.(!!(next.referenceFile || next.fontFile || next.license || next.licenseUrl || next.referencePermission || next.fontPermission || next.aspects.length || controller.hasUnsaved()));
  }
  const canUpload = canWrite && workspace?.capabilities.upload.status === "available";
  const disabled = !canUpload || state.busy || state.loading || !!state.pending || !isCurrent();
  const unsaved = !!(referenceFile || fontFile || license || licenseUrl || referencePermission || fontPermission || aspects.length || state.pending || state.busy);
  useEffect(() => {
    onUnsavedChange?.(unsaved);
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); if (!session) onUnsavedChange?.(false); };
  }, [onUnsavedChange, unsaved, session]);
  const retained: LogoReferenceRegistration[] = workspace ? savedReferences.filter(row => !state.references.some(saved => saved.referenceId === row.referenceId)).map(row => ({ ...row, workspace })) : [];
  const references = [...retained, ...state.references];
  async function uploadReference() {
    if (!referenceFile || disabled) return; await controller.uploadReference(referenceFile, aspects, referencePermission);
  }
  async function uploadFont() {
    if (!fontFile || disabled) return; await controller.uploadFont(fontFile, license, licenseUrl || null, fontPermission);
  }
  function changeSelection(reference: LogoReferenceRegistration, aspect: LogoReferenceSelection["aspects"][number], checked: boolean) {
    const prior = selections.find(item => item.referenceId === reference.referenceId)?.aspects ?? [];
    const nextAspects = logoReferenceAspectSchema.options.filter(value => value === aspect ? checked : prior.includes(value));
    const index = selections.findIndex(item => item.referenceId === reference.referenceId), next = selections.filter(item => item.referenceId !== reference.referenceId);
    if (nextAspects.length) next.splice(index < 0 ? next.length : index, 0, { referenceId: reference.referenceId, aspects: nextAspects });
    onSelectionsChange?.(next);
  }
  return <section className={styles.panel} aria-labelledby={title} aria-busy={state.busy || state.loading}>
    <div className={styles.heading}><h2 id={title}>{mode === "references" ? "Reference images" : mode === "fonts" ? "Project fonts" : "References and fonts"}</h2><button type="button" disabled={state.busy || state.loading} onClick={() => void controller.refresh()}>Refresh saved inputs</button></div>
    {!canUpload && <p className={styles.notice}>Connected owned storage is required before files can be uploaded or catalog fonts added. Saved inputs remain readable.</p>}
    {mode !== "fonts" && <>
      <h3>Curated references</h3><p className={styles.caption}>{CURATED_REFERENCE_UNAVAILABLE}</p>
      <h3>Your reference images</h3><p className={styles.caption}>PNG, JPEG or WebP, up to 32 MiB, 8,192 pixels per edge and 16,777,216 pixels total. References guide an original result; they do not grant permission to copy another logo.</p>
      <div className={styles.form}>
        <label>Choose a reference image<input key={referenceFile ? "reference-selected" : "reference-empty"} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={event => changeDraft({ referenceFile: event.currentTarget.files?.[0] ?? null, referencePermission: false })} /></label>
        {referenceFile && <p className={styles.caption}>Selected file: {referenceFile.name}</p>}
        <fieldset disabled={disabled}><legend>What do you like about this image?</legend><div className={styles.choices}>{logoReferenceAspectSchema.options.map(aspect => <label key={aspect}><input type="checkbox" checked={aspects.includes(aspect)} onChange={event => changeDraft({ aspects: logoReferenceAspectSchema.options.filter(value => value === aspect ? event.currentTarget.checked : aspects.includes(value)) })} />{REFERENCE_ASPECT_LABELS[aspect]}</label>)}</div></fieldset>
        <label className={styles.permission}><input type="checkbox" checked={referencePermission} disabled={disabled} onChange={event => changeDraft({ referencePermission: event.currentTarget.checked })} />{REFERENCE_PERMISSION}</label>
        <button type="button" disabled={disabled || !referenceFile || !referencePermission || !aspects.length} onClick={() => void uploadReference()}>Upload reference</button>
      </div>
      {references.length > 0 && <p className={styles.caption}>Choose the aspects to use, then save references in your logo brief. Uploading alone does not change the saved selection.</p>}
      <div className={styles.grid}>{references.map((reference, ordinal) => {
        const selected = selections.find(item => item.referenceId === reference.referenceId)?.aspects ?? [];
        return <fieldset className={styles.card} key={reference.referenceId} disabled={!onSelectionsChange || !canWrite || state.busy}>
          <legend>{reference.sourceKind === "curated" ? "Curated" : "Uploaded"} reference {ordinal + 1}</legend>
          <ReferencePreview client={client} reference={reference} isCurrent={isCurrent} />
          <div className={styles.choices}>{logoReferenceAspectSchema.options.map(aspect => <label key={aspect}><input type="checkbox" checked={selected.includes(aspect)} aria-label={`${REFERENCE_ASPECT_LABELS[aspect]} for saved reference ${ordinal + 1}`} onChange={event => changeSelection(reference, aspect, event.currentTarget.checked)} />{REFERENCE_ASPECT_LABELS[aspect]}</label>)}</div>
          <details><summary>Source and permission record</summary><p>Permission declaration retained for this exact image.</p><p>Version: {reference.asset.versionId}</p><p>SHA-256: {reference.asset.contentHash}</p></details>
        </fieldset>;
      })}</div>
      {state.referenceCursor && <button type="button" disabled={state.loading || state.busy} onClick={() => void controller.loadMore("references")}>Load more references</button>}
    </>}
    {mode !== "references" && <>
      <h3>Reviewed free-commercial fonts</h3><p className={styles.caption}>Add a verified font to this project before generating typography. These are font names and license details, not live font previews. Paid fonts are not offered.</p>
      {state.catalog.length === 0 && <p className={styles.caption}>No verified catalog entries are available in this view.</p>}
      <div className={styles.grid}>{state.catalog.map(font => {
        const added = state.fonts.some(row => row.source === "free_catalog" && row.asset.contentHash === font.rights.fontContentHash);
        return <div className={styles.card} key={font.id}><h4>{font.family} · {font.id.includes("italic") ? "Italic" : "Upright"}</h4>
          <p className={styles.caption}>Reviewed commercial use. Display, outlines, embedding, modification and redistribution are permitted subject to the license conditions.</p>
          <details><summary>License conditions</summary><ul>{font.conditions.map(condition => <li key={condition}>{condition}</li>)}</ul>{font.rights.sourceUrl && <a href={font.rights.sourceUrl} target="_blank" rel="noreferrer">License source</a>}</details>
          <button type="button" disabled={disabled || added} onClick={() => void controller.importCatalogFont(font.id)}>{added ? "Added to project" : `Add ${font.family} ${font.id.includes("italic") ? "italic" : "upright"}`}</button>
        </div>;
      })}</div>
      <h3>Upload a font you can use</h3><p className={styles.caption}>One TTF or OTF file up to 10 MiB, with its actual license text up to 256 KiB. {UPLOADED_FONT_REVIEW_NOTICE}</p>
      <div className={styles.form}>
        <label>Choose a font file<input key={fontFile ? "font-selected" : "font-empty"} type="file" accept="font/ttf,font/otf,.ttf,.otf" disabled={disabled} onChange={event => changeDraft({ fontFile: event.currentTarget.files?.[0] ?? null, fontPermission: false })} /></label>
        {fontFile && <p className={styles.caption}>Selected file: {fontFile.name}</p>}
        <label>Actual font license text<textarea disabled={disabled} value={license} onChange={event => changeDraft({ license: event.currentTarget.value })} maxLength={262144} rows={5} /></label>
        <label>License source URL (optional)<input type="url" placeholder="https://…" disabled={disabled} value={licenseUrl} onChange={event => changeDraft({ licenseUrl: event.currentTarget.value })} maxLength={2048} /></label>
        <label className={styles.permission}><input type="checkbox" disabled={disabled} checked={fontPermission} onChange={event => changeDraft({ fontPermission: event.currentTarget.checked })} />{FONT_PERMISSION}</label>
        <button type="button" disabled={disabled || !fontFile || !fontPermission || !license.trim()} onClick={() => void uploadFont()}>Save font and license</button>
      </div>
      {state.fonts.length > 0 && <><h3>Saved project fonts</h3><ul className={styles.saved}>{state.fonts.map(font => <li key={font.id}><strong>{font.family}</strong> · {fontPurposeAllowed(font, "render") ? "Reviewed display permission" : "Declaration saved; use unavailable pending review"}<details><summary>Exact version and permissions</summary><p>Font version: {font.id}</p><p>SHA-256: {font.asset.contentHash}</p><p>License SHA-256: {font.rights.licenseTextHash}</p><ul>{Object.entries(font.rights.permissions).map(([purpose, permission]) => <li key={purpose}>{purpose}: {font.rights.sourceKind === "reviewed_license" ? permission : "unreviewed"}</li>)}</ul></details></li>)}</ul></>}
    </>}
    {state.unresolved.length > 0 && <div className={styles.notice}><h3>Interrupted input requests</h3><p>These requests were retained on the server. Checking does not upload or import again.</p>{state.unresolved.map(request => <div key={request.input.requestKey}><p>{request.kind === "reference_upload" ? "Reference image upload" : request.kind === "font_upload" ? "Font upload" : "Catalog font import"} · {request.input.requestKey}</p><button type="button" disabled={state.busy || !!state.pending} onClick={() => void controller.recover(request.input.requestKey)}>Check interrupted input</button></div>)}{state.requestCursor && <button type="button" disabled={state.loading || state.busy} onClick={() => void controller.loadMore("requests")}>Load more interrupted inputs</button>}</div>}
    {state.pending && <div className={styles.notice}><h3>Original input request</h3><p>Request: {state.pending.input.requestKey}</p><p>Its exact inputs are retained. A retry always reuses this request.</p>
      <button type="button" disabled={state.busy || state.loading} onClick={() => void controller.check()}>Check original input</button>
      {state.pending.kind !== "font_catalog" && !state.hasOriginalFile && <label>Choose the original file again<input type="file" accept={state.pending.file.mimeType} disabled={state.busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void controller.attachOriginalFile(file); }} /></label>}
      {state.pendingStatus !== "rejected" && <button type="button" disabled={state.busy || state.loading} onClick={() => void controller.cancel()}>Cancel original input</button>}
      {state.pendingStatus === "rejected" ? <button type="button" disabled={state.busy} onClick={() => controller.dismissRejected()}>Close checked request</button>
        : <button type="button" disabled={!canUpload || state.busy || !["pending", "not_found"].includes(state.pendingStatus ?? "") || state.pending.kind !== "font_catalog" && !state.hasOriginalFile} onClick={() => void controller.retry()}>Retry unchanged input</button>}
    </div>}
    {draftError && <p role="alert" className={styles.notice}>{draftError}</p>}
    {state.error && <p role="alert" className={styles.notice}>{state.error}</p>}
    {state.message && <p role="status" className={styles.caption}>{state.message}</p>}
  </section>;
}
function ReferencePreview({ client, reference, isCurrent }: { client: LogoInputClient; reference: LogoReferenceRegistration; isCurrent(): boolean }) {
  const [state, setState] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let preview: InputPreview | null = null;
    void client.previewLogoReference(reference, controller.signal).then(value => {
      if (controller.signal.aborted || !isCurrent()) { value?.release(); return; }
      preview = value; setState({ id: reference.referenceId, url: value?.url ?? null });
    }).catch(() => { if (!controller.signal.aborted && isCurrent()) setState({ id: reference.referenceId, url: null }); });
    return () => { controller.abort(); preview?.release(); };
  }, [client, reference, isCurrent]);
  const visible = isCurrent() && state?.id === reference.referenceId ? state : null;
  // eslint-disable-next-line @next/next/no-img-element -- the account client verifies the private object URL and owns its release.
  return <div className={styles.preview}>{visible?.url ? <img src={visible.url} alt="Saved reference image" /> : <p>{visible ? "Preview unavailable. Saved reference retained." : "Loading verified reference…"}</p>}</div>;
}
