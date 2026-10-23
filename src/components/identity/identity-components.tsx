"use client";
import type { ReactNode } from "react";
import { IdentityEditorFeedback } from "./identity-editor-feedback";
import { ContextDetails } from "@/components/ui/context-details";

import { identityDraftChanged } from "./identity-draft-memory";
import type { ProjectIdentityController } from "./use-project-identity";
import { IdentityProductionFiles } from "./identity-system-board";

function RecoveryActions({ controller, component }: { controller: ProjectIdentityController; component: "colors" | "typography" }) {
  return <div className="identity-recovery" role="status"><p>{controller.pending ? "Saving the manual edit…" : "The original save could not be confirmed. Retrying sends that exact request again."}</p><div className="identity-actions">
    <button type="button" className="identity-secondary-button" disabled={controller.pending || controller.loading} onClick={() => { void controller.refresh(); }}>Check latest</button>
    <button type="button" className="identity-secondary-button" disabled={controller.blocked} onClick={() => { void controller.saveComponent(component, false, true); }}>Retry original {component} save</button>
    <button type="button" className="text-link" disabled={controller.pending} onClick={() => controller.discardComponent(component)}>Discard local recovery</button>
  </div><p>Discarding this record does not undo a save that may already have completed.</p></div>;
}
function ColorEditor({ controller, acknowledged, editorContext }: { controller: ProjectIdentityController; acknowledged: boolean; editorContext?: ReactNode }) {
  const draft = controller.colors; if (!draft) return null;
  const form = draft.value;
  return <ContextDetails className="identity-component-editor" title={<>Edit colors</>}><IdentityEditorFeedback controller={controller} />{editorContext}<form onSubmit={event => { event.preventDefault(); void controller.saveComponent("colors", acknowledged); }}>
    <fieldset disabled={controller.pending || Boolean(draft.pending)}><legend className="sr-only">Manual color specification</legend>
      {form.swatches.map((swatch, index) => <div className="identity-color-row" key={swatch.key}>
        <label>Name<input aria-label={`Color ${index + 1} name`} value={swatch.name} maxLength={240} onChange={event => controller.setColors({ ...form, swatches: form.swatches.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row) })} /></label>
        <label>Hex<input aria-label={`Color ${index + 1} hex`} value={swatch.hex} maxLength={32} spellCheck={false} onChange={event => controller.setColors({ ...form, swatches: form.swatches.map((row, rowIndex) => rowIndex === index ? { ...row, hex: event.target.value } : row) })} /></label>
        <button type="button" className="text-link" aria-label={`Remove color ${index + 1}`} disabled={form.swatches.length <= 1} onClick={() => controller.setColors({ ...form, swatches: form.swatches.filter((_, rowIndex) => rowIndex !== index) })}>Remove</button>
      </div>)}
      <button type="button" className="text-link" disabled={form.swatches.length >= 16} onClick={() => controller.setColors({ ...form, swatches: [...form.swatches, { key: `color-${crypto.randomUUID()}`, name: "", hex: "#" }] })}>Add color</button>
      <label>Color usage notes<textarea aria-label="Color usage notes" value={form.usageNotes} maxLength={4000} onChange={event => controller.setColors({ ...form, usageNotes: event.target.value })} /></label>
    </fieldset>
    {!draft.pending && controller.savesUnavailable && <p id="identity-colors-save-unavailable" className="identity-control-unavailable">Saving manual edits is unavailable right now. Your local edits are kept in this tab.</p>}
    {!draft.pending && <div className="identity-actions"><button aria-describedby={controller.savesUnavailable ? "identity-colors-save-unavailable" : undefined} className="identity-primary-button" type="submit" disabled={controller.blocked || !acknowledged || !identityDraftChanged(draft)}>Save colors as new version</button>
      <button type="button" className="text-link" disabled={controller.pending || !identityDraftChanged(draft)} onClick={() => controller.discardComponent("colors")}>Discard color edits</button></div>}
    {draft.pending && <RecoveryActions controller={controller} component="colors" />}
  </form></ContextDetails>;
}
function TypographyEditor({ controller, acknowledged, editorContext }: { controller: ProjectIdentityController; acknowledged: boolean; editorContext?: ReactNode }) {
  const draft = controller.typography; if (!draft) return null;
  const form = draft.value;
  return <ContextDetails className="identity-component-editor" title={<>Edit typography</>}><IdentityEditorFeedback controller={controller} />{editorContext}<form onSubmit={event => { event.preventDefault(); void controller.saveComponent("typography", acknowledged); }}>
    <fieldset disabled={controller.pending || Boolean(draft.pending)}><legend className="sr-only">Manual typography specification</legend>
      {form.styles.map((style, index) => <div className="identity-type-row" key={style.key}>
        <label>Role<input aria-label={`Type ${index + 1} role`} value={style.role} maxLength={240} onChange={event => controller.setTypography({ ...form, styles: form.styles.map((row, rowIndex) => rowIndex === index ? { ...row, role: event.target.value } : row) })} /></label>
        <label>Family<input aria-label={`Type ${index + 1} family`} value={style.family} maxLength={320} onChange={event => controller.setTypography({ ...form, styles: form.styles.map((row, rowIndex) => rowIndex === index ? { ...row, family: event.target.value } : row) })} /></label>
        <label>Weight<input aria-label={`Type ${index + 1} weight`} type="number" min={1} max={1000} step={1} value={style.weight} onChange={event => controller.setTypography({ ...form, styles: form.styles.map((row, rowIndex) => rowIndex === index ? { ...row, weight: event.target.value } : row) })} /></label>
        <label>Style<select aria-label={`Type ${index + 1} style`} value={style.style} onChange={event => controller.setTypography({ ...form, styles: form.styles.map((row, rowIndex) => rowIndex === index ? { ...row, style: event.target.value as "normal" | "italic" | "oblique" } : row) })}><option value="normal">Normal</option><option value="italic">Italic</option><option value="oblique">Oblique</option></select></label>
        <button type="button" className="text-link" aria-label={`Remove type style ${index + 1}`} disabled={form.styles.length <= 1} onClick={() => controller.setTypography({ ...form, styles: form.styles.filter((_, rowIndex) => rowIndex !== index) })}>Remove</button>
      </div>)}
      <button type="button" className="text-link" disabled={form.styles.length >= 8} onClick={() => controller.setTypography({ ...form, styles: [...form.styles, { key: `type-${crypto.randomUUID()}`, role: "", family: "", weight: "400", style: "normal" }] })}>Add type style</button>
      <label>Typography usage notes<textarea aria-label="Typography usage notes" value={form.usageNotes} maxLength={4000} onChange={event => controller.setTypography({ ...form, usageNotes: event.target.value })} /></label>
    </fieldset>
    {!draft.pending && controller.savesUnavailable && <p id="identity-typography-save-unavailable" className="identity-control-unavailable">Saving manual edits is unavailable right now. Your local edits are kept in this tab.</p>}
    {!draft.pending && <div className="identity-actions"><button aria-describedby={controller.savesUnavailable ? "identity-typography-save-unavailable" : undefined} type="submit" className="identity-primary-button" disabled={controller.blocked || !acknowledged || !identityDraftChanged(draft)}>Save typography as new version</button>
      <button type="button" className="text-link" disabled={controller.pending || !identityDraftChanged(draft)} onClick={() => controller.discardComponent("typography")}>Discard typography edits</button></div>}
    {draft.pending && <RecoveryActions controller={controller} component="typography" />}
  </form></ContextDetails>;
}

export function IdentityComponents({ controller, acknowledged, editorContext }: { controller: ProjectIdentityController; acknowledged: boolean; editorContext?: ReactNode }) {
  const { system, client } = controller; if (!system || !client) return null;
  const components = system.components;
  return <div className="identity-components">
    <section aria-labelledby="identity-logo-title"><h4 id="identity-logo-title">Logo</h4><p>{components.logo.direction}</p><p className="identity-muted">{components.logo.usageNotes}</p><p className="identity-muted">Image refinement is unavailable.</p></section>
    <section aria-labelledby="identity-colors-title"><h4 id="identity-colors-title">Colors</h4><ul className="identity-swatches">{components.colors.swatches.map(color => <li key={color.key}><span className="identity-swatch" style={{ backgroundColor: color.hex }} /><div>{color.name}<code>{color.hex}</code></div></li>)}</ul><p className="identity-muted">{components.colors.usageNotes}</p><ColorEditor controller={controller} acknowledged={acknowledged} editorContext={editorContext} /></section>
    <section aria-labelledby="identity-typography-title"><h4 id="identity-typography-title">Typography</h4><ul className="identity-type-specification">{components.typography.styles.map(style => <li key={style.key}><strong>{style.role}</strong><span>{style.family} · {style.weight} · {style.style}</span></li>)}</ul><p className="identity-muted">Saved family specifications do not install fonts or establish a license.</p><p className="identity-muted">{components.typography.usageNotes}</p><TypographyEditor controller={controller} acknowledged={acknowledged} editorContext={editorContext} /></section>
    <section aria-labelledby="identity-graphics-title"><h4 id="identity-graphics-title">Graphics</h4><p>{components.graphics.direction}</p><p className="identity-muted">{components.graphics.usageNotes}</p><p className="identity-muted">Image refinement is unavailable.</p></section>
    <section aria-labelledby="identity-imagery-title"><h4 id="identity-imagery-title">Imagery</h4><p>{components.imagery.direction}</p><p className="identity-muted">{components.imagery.usageNotes}</p><p className="identity-muted">Image refinement is unavailable.</p></section>
    <section aria-labelledby="identity-composition-title"><h4 id="identity-composition-title">Composition</h4><p>{components.composition.direction}</p><p className="identity-muted">{components.composition.usageNotes}</p></section>
    <IdentityProductionFiles files={system.productionFiles} client={client} />
  </div>;
}
