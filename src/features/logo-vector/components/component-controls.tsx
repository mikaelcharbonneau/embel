import type { ChangeEvent, FocusEvent, KeyboardEvent } from "react";
import { logoManualEditSchema, type LogoManualEdit, type LogoVectorDocument } from "../../../domain/logo-vector";
import styles from "./logo-vector.module.css";

type Props = {
  document: LogoVectorDocument;
  componentId: string;
  lockedComponentIds: readonly string[];
  onEdit: (edit: LogoManualEdit) => void;
  disabledReason?: string;
  showTextPlaceholder?: boolean;
};

/** Controlled presentation: a lock intent is not a saved lock or server validation. */
export function ComponentControls({ document, componentId, lockedComponentIds, onEdit, disabledReason, showTextPlaceholder = true }: Props) {
  const component = document.components.find(item => item.id === componentId);
  if (!component) return <p role="status">Choose a component to edit.</p>;
  const locked = lockedComponentIds.includes(componentId);
  const disabled = Boolean(disabledReason) || locked;
  const emit = (edit: LogoManualEdit) => {
    if (disabledReason || (locked && edit.kind !== "locks")) return;
    const result = logoManualEditSchema.safeParse(edit);
    if (result.success) onEdit(result.data);
  };
  const numberEdit = (input: HTMLInputElement, authoritativeValue: number, create: (value: number) => LogoManualEdit) => {
    if (disabled) return;
    const value = input.value.trim();
    const result = value !== "" && Number.isFinite(Number(value)) ? logoManualEditSchema.safeParse(create(Number(value))) : null;
    if (!result?.success) {
      input.setCustomValidity("Enter a complete number within this control's limits.");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    if (Number(value) === authoritativeValue) return;
    emit(result.data);
  };
  // The native input owns disposable text while typing. A changed key resets it to authoritative values.
  const numericInput = (value: number, create: (value: number) => LogoManualEdit) => ({
    defaultValue: value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => event.currentTarget.setCustomValidity(""),
    onBlur: (event: FocusEvent<HTMLInputElement>) => numberEdit(event.currentTarget, value, create),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
    },
  });
  const placement = (axis: "x" | "y", value: number): LogoManualEdit => ({
    kind: "arrangement", order: document.components.map(item => item.id),
    placements: [{ componentId, transform: { ...component.transform, [axis]: value } }],
  });
  const fills = new Set(component.paths.map(path => path.fill?.color ?? null));
  const strokes = new Set(component.paths.map(path => path.stroke?.color ?? null));
  const uniformPaint = fills.size === 1 && strokes.size === 1;
  const fill = component.paths[0]!.fill?.color ?? null;
  const stroke = component.paths[0]!.stroke?.color ?? null;
  return <section className={styles.controls} aria-label="Component controls">
    <div className={styles.headingRow}>
      <h3>{component.role.replaceAll("_", " ")}</h3>
      <button type="button" aria-pressed={locked} disabled={Boolean(disabledReason)} onClick={() => emit({
        kind: "locks", componentIds: locked ? lockedComponentIds.filter(id => id !== componentId) : [...lockedComponentIds, componentId],
      })}>{locked ? "Unlock component" : "Lock component"}</button>
    </div>
    {disabledReason && <p role="status">{disabledReason}</p>}
    {locked && <p>Locked. Save an explicit unlock before changing this component.</p>}
    <fieldset disabled={disabled} className={styles.fields}>
      <legend>Whole component</legend>
      <label>Scale<input key={`${componentId}:scale:${component.transform.scale}`} aria-label="Component scale" type="number" min="0.01" max="100" step="any" {...numericInput(component.transform.scale, scale => ({ kind: "size", componentId, scale }))} /></label>
      <label>Rotation (°)<input key={`${componentId}:rotation:${component.transform.rotation}`} aria-label="Component rotation" type="number" min="-180" max="180" step="any" {...numericInput(component.transform.rotation, degrees => ({ kind: "rotation", componentId, degrees }))} /></label>
      <label>X position<input key={`${componentId}:x:${component.transform.x}`} aria-label="Component X position" type="number" min="-1000000" max="1000000" step="any" {...numericInput(component.transform.x, value => placement("x", value))} /></label>
      <label>Y position<input key={`${componentId}:y:${component.transform.y}`} aria-label="Component Y position" type="number" min="-1000000" max="1000000" step="any" {...numericInput(component.transform.y, value => placement("y", value))} /></label>
      <label>Fill color<input aria-label="Component fill color" type="color" disabled={!uniformPaint || fill === null} value={fill ?? "#000000"} onChange={event => emit({ kind: "color", componentId, fill: event.currentTarget.value.toUpperCase(), stroke })} /></label>
      <label>Stroke color<input aria-label="Component stroke color" type="color" disabled={!uniformPaint || stroke === null} value={stroke ?? "#000000"} onChange={event => emit({ kind: "color", componentId, fill, stroke: event.currentTarget.value.toUpperCase() })} /></label>
    </fieldset>
    <p>Press Enter or leave a numeric field to apply its value.</p>
    {!uniformPaint && <p>Multiple paints are preserved. A single-color replacement is unavailable for this component.</p>}
    {component.role === "whole_artwork" && <p>Move the whole artwork. Separate symbol and lettering arrangement needs explicitly separated components.</p>}
    {showTextPlaceholder && <><fieldset disabled className={styles.fields}>
      <legend>{component.editingKind === "outlined_custom" ? "Outlined lettering" : "Text and font"}</legend>
      <button type="button">Change font</button><button type="button">Change spacing</button>
    </fieldset>
    <p>Font editing is unavailable until verified font rights and text shaping are connected.{component.editingKind === "outlined_custom" ? " Outlined lettering is geometry; font replacement requires an explicit new revision." : ""}</p></>}
  </section>;
}
