"use client";

import { useState, type FormEvent } from "react";
import type { FontRecord } from "../../../domain/logo-directions";
import { logoManualEditSchema, type LogoManualEdit, type LogoType, type LogoVectorDocument } from "../../../domain/logo-vector";
import { fontPurposeAllowed } from "../../identity-directions/model/font-rights";
import styles from "./logo-vector.module.css";

type Props = {
  document: LogoVectorDocument;
  componentId: string;
  lockedComponentIds: readonly string[];
  fonts: readonly FontRecord[];
  briefName: string | null;
  logoType: LogoType | null;
  onEdit(edit: LogoManualEdit): void;
  disabledReason?: string;
};

/** Pending commands only. No CSS font-name preview, font download, server save,
 * provider dispatch, or automatic acceptance is performed by these controls. */
export function TextControls(props: Props) {
  const component = props.document.components.find(item => item.id === props.componentId);
  const source = component?.editingKind === "editable_text" ? component.textSource : null;
  const key = JSON.stringify([props.componentId, component?.editingKind, source, props.briefName, props.logoType]);
  return <TextControlForm key={key} {...props} />;
}
function TextControlForm({ document, componentId, lockedComponentIds, fonts, briefName, logoType, onEdit, disabledReason }: Props) {
  const [replacing, setReplacing] = useState(false), [contentKind, setContentKind] = useState<"brand_name" | "approved_initials">("brand_name"), [error, setError] = useState<string | null>(null);
  const component = document.components.find(item => item.id === componentId);
  if (!component) return null;
  const source = component.editingKind === "editable_text" ? component.textSource : null;
  const permitted = fonts.filter(font => fontPurposeAllowed(font, "render") && fontPurposeAllowed(font, "outline"));
  const locked = lockedComponentIds.includes(componentId), disabled = Boolean(disabledReason) || locked || briefName === null || logoType === null;
  const savedFont = source ? permitted.find(font => font.asset.assetId === source.font.assetId && font.asset.versionId === source.font.versionId && font.asset.contentHash === source.font.contentHash && font.rights.id === source.rightsEvidenceId) : null;
  const emit = (raw: LogoManualEdit) => {
    if (disabled) return;
    const parsed = logoManualEditSchema.safeParse(raw);
    if (!parsed.success) { setError("Enter complete text and numbers within the control limits."); return; }
    setError(null); onEdit(parsed.data);
  };
  const submit = (run: (data: FormData) => void) => (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!disabled) run(new FormData(event.currentTarget)); };
  const chooseFont = (data: FormData): string | null => {
    const id = String(data.get("fontVersionId") ?? "");
    if (!permitted.some(font => font.id === id)) { setError("Choose an owned font with render and outline permission."); return null; }
    return id;
  };
  const options = <><option value="">Choose an owned font</option>{permitted.map(font => <option key={font.id} value={font.id}>{font.family}</option>)}</>;
  if (component.role !== "lettering" || (!source && component.editingKind !== "outlined_custom")) return <section className={styles.controls} aria-label="Text controls"><p>Text replacement requires an explicitly separated lettering-only component. Fused illustrations and symbols keep their geometry.</p></section>;
  return <section className={styles.controls} aria-label="Text controls">
    <h3>{source ? "Editable lettering" : "Outlined custom lettering"}</h3>
    {disabledReason && <p role="status">{disabledReason}</p>}
    {locked && <p>Save an explicit unlock before changing lettering.</p>}
    {(briefName === null || logoType === null) && <p role="status">The exact saved name and logo source are unavailable. Reload before editing text.</p>}
    {!permitted.length && <p role="status">Import a font with verified render and outline permission before editing lettering.</p>}
    {error && <p role="alert">{error}</p>}
    {!source ? <>
      <p>This lettering has no editable font source. Replacing it creates a separate font-based version.</p>
      {!replacing ? <button type="button" disabled={disabled || !permitted.length} onClick={() => { setReplacing(true); setContentKind("brand_name"); setError(null); }}>Replace outlined lettering</button> : <form onSubmit={submit(data => {
        const fontVersionId = chooseFont(data); if (!fontVersionId || briefName === null) return;
        if (contentKind === "approved_initials" && (logoType !== "lettermark_monogram" || data.get("approveInitials") !== "on")) { setError("Explicitly approve the initials before preparing this replacement."); return; }
        emit({ kind: "replace_outlined_lettering", componentId, fontVersionId, contentKind, text: contentKind === "brand_name" ? briefName : String(data.get("initials") ?? "") });
      })}>
        <fieldset disabled={disabled} className={styles.fields}><legend>Explicit lettering replacement</legend>
          {logoType === "lettermark_monogram" && <label>Lettering content<select aria-label="Replacement content" value={contentKind} onChange={event => { setContentKind(event.currentTarget.value as typeof contentKind); setError(null); }}><option value="brand_name">Full saved brand name</option><option value="approved_initials">Initials I explicitly approve</option></select></label>}
          {contentKind === "brand_name" ? <label>Saved brand name<input aria-label="Replacement brand name" value={briefName ?? ""} readOnly /></label> : <><label>Approved initials<input aria-label="Approved initials" name="initials" maxLength={400} required /></label><label><input aria-label="Approve these initials" name="approveInitials" type="checkbox" required /> I approve these exact initials for this lettermark.</label></>}
          <label>Font<select aria-label="Replacement font" name="fontVersionId" defaultValue="" required>{options}</select></label>
        </fieldset>
        <div className={styles.actions}><button type="submit" disabled={disabled || !permitted.length}>Prepare lettering replacement</button><button type="button" disabled={Boolean(disabledReason)} onClick={() => { setReplacing(false); setContentKind("brand_name"); setError(null); }}>Cancel lettering replacement</button></div>
      </form>}
    </> : <>
      {source.contentKind === "brand_name" ? <p>Saved name: {source.text}. To change its spelling, update the brief and create a new logo source.</p> : <form onSubmit={submit(data => { if (savedFont && logoType === "lettermark_monogram") emit({ kind: "text", componentId, text: String(data.get("text") ?? "") }); })}>
        <fieldset disabled={disabled || !savedFont || logoType !== "lettermark_monogram"} className={styles.fields}><legend>Explicitly approved initials</legend><label>Initials<input aria-label="Editable initials" name="text" defaultValue={source.text} maxLength={400} required /></label><button type="submit">Set initials</button></fieldset>
      </form>}
      <form onSubmit={submit(data => { const fontVersionId = chooseFont(data); if (fontVersionId && fontVersionId !== savedFont?.id) emit({ kind: "font", componentId, fontVersionId }); })}>
        <fieldset disabled={disabled || !permitted.length || !savedFont} className={styles.fields}><legend>Font</legend><label>Owned font<select aria-label="Lettering font" name="fontVersionId" defaultValue={savedFont?.id ?? ""} required>{options}</select></label><button type="submit">Use this font</button></fieldset>
      </form>
      <form onSubmit={submit(data => {
        const spacing = String(data.get("letterSpacing") ?? "");
        if (!spacing.trim()) { setError("Enter a complete letter-spacing value."); return; }
        const letterSpacing = Number(spacing), lineHeight = source.lineHeight;
        if (letterSpacing !== source.letterSpacing) emit({ kind: "spacing", componentId, letterSpacing, lineHeight });
      })}>
        <fieldset disabled={disabled || !savedFont} className={styles.fields}><legend>Text spacing</legend><label>Letter spacing<input aria-label="Letter spacing" name="letterSpacing" type="number" step="any" min="-1000000" max="1000000" defaultValue={source.letterSpacing} required /></label><button type="submit">Set spacing</button></fieldset>
      </form>
      <p>Single-line lettering keeps its saved line height. Line-height changes are unavailable.</p>
      {!savedFont && <p role="status">The exact saved font and rights record must be available before changing this text.</p>}
      {source.script === "Arab" && <p>Joining scripts require zero letter spacing. Unsupported changes preserve this version.</p>}
    </>}
    <p>Save edit creates a new lettering version from verified font bytes. The preview stays unchanged until then. Compare the saved result before accepting it.</p>
  </section>;
}
