import { logoTypeSchema, type LogoBriefDraft } from "../../domain/logo-workspace";
import { brandTextReadiness } from "../../domain/brand-board-fonts";
import { LOGO_TYPE_LABELS } from "./presentation";
import styles from "./logo-creation.module.css";
import stage from "@/styles/branding-stage.module.css";

/** Controlled fields; the workspace owns autosave and any immediate-save action. */
export function LogoBriefFields({
  draft = { name: "", activity: "", audience: "", personality: "", logoTypes: [] },
  onChange, onReuseStrategy, onSave, saveMessage = "Saving is unavailable. Changes have not been saved.", nameConflict = false, sourceProjectRevision, saveLabel = "Save brief", autoSave = false,
}: {
  draft?: LogoBriefDraft;
  onChange?: (draft: LogoBriefDraft) => void;
  onReuseStrategy?: () => void;
  onSave?: () => void;
  saveMessage?: string;
  saveLabel?: string;
  nameConflict?: boolean;
  sourceProjectRevision?: number;
  autoSave?: boolean;
}) {
  const nameReadiness = draft.name.trim() ? brandTextReadiness(draft.name) : null;
  const fields = [
    ["name", "Brand name"], ["activity", "What the business does"],
    ["audience", "Audience"], ["personality", "Desired personality"],
  ] as const;
  return <section className={styles.panel} aria-label="Logo brief">
    <div className={styles.heading}>
      <div><p className={styles.eyebrow}>01 / Brief</p><h2 className={stage.sectionHeading}>Start with your brand</h2></div>
      <button className={styles.secondaryButton} type="button" aria-label="Reuse Strategy" disabled={!onReuseStrategy || !onChange} onClick={onReuseStrategy}>Reuse Strategy</button>
    </div>
    <p className={styles.muted}>Write a short brief or choose to reuse your saved Strategy. You can start before Strategy is complete.</p>
    {autoSave && <p className={styles.note}>Changes save automatically. You can also save immediately below.</p>}
    {sourceProjectRevision !== undefined && <p className={styles.note}>Copied from Strategy revision {sourceProjectRevision}. Review and edit the brief below.</p>}
    {nameConflict && <p className={styles.warning} role="alert">Your selected name differs from the original supplied name. The selected name is copied below; review its exact spelling before generating.</p>}
    <div className={styles.fields}>
      {fields.map(([key, label]) => <label className={styles.field} key={key}>
        <span>{label}</span>
        {key === "name" ? <input aria-label={label} type="text" value={draft[key]} disabled={!onChange} aria-invalid={Array.from(draft.name).length > 200}
          onChange={event => onChange?.({ ...draft, [key]: event.currentTarget.value })} /> :
          <textarea aria-label={label} rows={3} value={draft[key]} disabled={!onChange}
            onChange={event => onChange?.({ ...draft, [key]: event.currentTarget.value })} />}
      </label>)}
    </div>
    {nameReadiness?.message && <p className={styles.warning} role="alert">{nameReadiness.message}</p>}
    {Array.from(draft.name).length > 200 && <p className={styles.warning} role="alert">Shorten the brand name to 200 characters before saving. Your text is still here.</p>}
    <fieldset className={styles.typeChoices} disabled={!onChange}>
      <legend>Logo types <span className={styles.muted}>Choose one or more</span></legend>
      {logoTypeSchema.options.map(type => <label className={styles.choice} key={type}>
        <input type="checkbox" aria-label={LOGO_TYPE_LABELS[type]} checked={draft.logoTypes.includes(type)} onChange={event => {
          const selected = event.currentTarget.checked;
          onChange?.({ ...draft, logoTypes: logoTypeSchema.options.filter(option => option === type ? selected : draft.logoTypes.includes(option)) });
        }} />
        <span>{LOGO_TYPE_LABELS[type]}</span>
      </label>)}
    </fieldset>
    {draft.logoTypes.length === 7 && <p className={styles.note}>Six concepts total. With seven types selected, one type will be left for a later batch. Review the exact coverage before generation.</p>}
    <div className={styles.actions}><button type="button" className={styles.primaryButton} aria-label={saveLabel} disabled={!onSave} onClick={onSave}>{saveLabel}</button><span className={styles.muted} role="status">{saveMessage}</span></div>
  </section>;
}
