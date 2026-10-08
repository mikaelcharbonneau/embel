import { logoReferenceAspectSchema, type LogoReferenceRegistration, type LogoReferenceSelection, type LogoReferenceSnapshot } from "../../domain/logo-workspace";
import { REFERENCE_ASPECT_LABELS } from "./presentation";
import styles from "./logo-creation.module.css";

/** Renders supplied owned registrations only; it cannot upload, import or grant rights. */
export function LogoReferencePickerView({ references = [], selections = [], onChange, statusMessage = "Your choices are not saved yet. References guide an original result; they do not grant permission to copy another logo." }: {
  references?: readonly (LogoReferenceRegistration | LogoReferenceSnapshot["references"][number])[];
  selections?: readonly LogoReferenceSelection[];
  onChange?: (selections: LogoReferenceSelection[]) => void;
  statusMessage?: string;
}) {
  return <section className={styles.panel} aria-label="Logo references">
    <p className={styles.eyebrow}>02 / References</p><h2>What catches your eye?</h2>
    <p className={styles.muted}>References are optional. Choose lettering, shape, composition or overall feel to guide an original logo.</p>
    <div className={styles.referenceSources}>
      <div className={styles.sourcePanel}>
        <h3>Curated library</h3><p className={styles.note}>Reference library unavailable. Source and licensing checks must be completed before examples can be offered.</p>
        <button className={styles.secondaryButton} type="button" aria-label="Browse reference library" disabled>Browse reference library</button>
      </div>
      <div className={styles.sourcePanel}>
        <h3>Your uploads</h3><p className={styles.note}>Uploads are unavailable. An image can be used only after its file and access checks and your permission declaration.</p>
        <label className={styles.field}><span>Choose a reference image</span><input type="file" aria-label="Choose a reference image" accept="image/png,image/jpeg,image/webp" disabled /></label>
        <label className={styles.permission}><input type="checkbox" disabled checked={false} readOnly /><span>I have permission to use and process this image.</span></label>
      </div>
    </div>
    {references.length > 0 && <p className={styles.note}>Choose what you like in each saved reference. Clear every aspect to remove it from your selection.</p>}
    <div className={styles.references}>
      {references.map(reference => {
        const source = reference.sourceKind === "curated" ? "curated" : "uploaded";
        const sourceOrdinal = references.filter(item => item.sourceKind === reference.sourceKind).findIndex(item => item.referenceId === reference.referenceId) + 1;
        const label = `${source} reference ${sourceOrdinal}`;
        const selected = selections.find(selection => selection.referenceId === reference.referenceId)?.aspects ?? [];
        return <fieldset className={styles.referenceCard} key={reference.referenceId} disabled={!onChange}>
          <legend>{source === "curated" ? "Curated" : "Uploaded"} reference {sourceOrdinal}</legend>
          <p className={styles.note}>Permission record attached. Preview unavailable.</p>
          <details className={styles.note}><summary>Saved image details</summary><p>Image version: {reference.asset.versionId}</p><p>Content hash: {reference.asset.contentHash}</p></details>
          <div className={styles.aspects}>
            {logoReferenceAspectSchema.options.map(aspect => <label className={styles.choice} key={aspect}>
              <input type="checkbox" aria-label={`${REFERENCE_ASPECT_LABELS[aspect]} for ${label}`} checked={selected.includes(aspect)} onChange={event => {
                const checked = event.currentTarget.checked;
                const aspects = logoReferenceAspectSchema.options.filter(option => option === aspect ? checked : selected.includes(option));
                const existingIndex = selections.findIndex(selection => selection.referenceId === reference.referenceId);
                const next = selections.filter(selection => selection.referenceId !== reference.referenceId);
                if (aspects.length) next.splice(existingIndex < 0 ? next.length : existingIndex, 0, { referenceId: reference.referenceId, aspects });
                onChange?.(next);
              }} />
              <span>{REFERENCE_ASPECT_LABELS[aspect]}</span>
            </label>)}
          </div>
        </fieldset>;
      })}
    </div>
    <p className={styles.note}>{statusMessage}</p>
  </section>;
}
