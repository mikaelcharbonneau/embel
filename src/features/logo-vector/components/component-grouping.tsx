"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { logoManualEditSchema, type LogoManualEdit, type LogoVectorDocument } from "../../../domain/logo-vector";
import { groupLogoComponents } from "../model/components";
import { canonicalizeLogoPath, flattenLogoPaths, getLogoComponentPaintedBounds, getLogoPathPaintedBounds, type LogoPaintedBounds } from "../model/geometry";
import { serializeLogoSvg } from "../model/svg";
import styles from "./logo-vector.module.css";

type Props = { document: LogoVectorDocument; lockedComponentIds: readonly string[]; onEdit: (edit: LogoManualEdit) => void; disabledReason?: string };
type Region = Extract<LogoManualEdit, { kind: "group_components" }>["regions"][number];
const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
const intersects = (a: LogoPaintedBounds | null, b: LogoPaintedBounds | null) => Boolean(a && b && a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY);

/** Advisory client guard only. Saving still verifies all authoritative lock digests. */
function lockWarning(base: LogoVectorDocument, candidate: LogoVectorDocument, ids: readonly string[]): string | null {
  const before = new Map(base.components.map((component, index) => [component.id, { index, value: stableJson(component), bounds: getLogoComponentPaintedBounds(component) }]));
  const after = new Map(candidate.components.map((component, index) => [component.id, { index, value: stableJson(component), bounds: getLogoComponentPaintedBounds(component) }]));
  const unchanged = new Set([...before].filter(([id, a]) => { const b = after.get(id); return b && a.index === b.index && a.value === b.value; }).map(([id]) => id));
  for (const id of ids) {
    const locked = before.get(id);
    if (!locked || !unchanged.has(id)) return "This grouping would change a locked component or its drawing-order position. Save an explicit unlock first.";
    for (const other of new Set([...before.keys(), ...after.keys()])) {
      if (other !== id && !unchanged.has(other) && (intersects(locked.bounds, before.get(other)?.bounds ?? null) || intersects(locked.bounds, after.get(other)?.bounds ?? null))) {
        return "This grouping would change artwork overlapping a locked component. Save an explicit unlock first.";
      }
    }
  }
  return null;
}

/** A bounded rectangle chooser, with no inferred semantic regions or path/anchor editor. */
export function ComponentGrouping(props: Props) {
  const [open, setOpen] = useState(false);
  const eligible = props.document.components.some(component => component.editingKind !== "editable_text" && !props.lockedComponentIds.includes(component.id));
  const disabledReason = props.disabledReason ?? (!eligible ? "Unlock an outlined or geometry component before grouping its paths. Editable text stays intact." : undefined);
  return <section className={styles.controls} aria-label="Whole-path component grouping">
    <h3>Separate artwork components</h3>
    <p>Choose rectangles around complete existing paths, then label their roles. Lettering stays outlined; no font is inferred.</p>
    {!open && <button type="button" disabled={Boolean(disabledReason)} onClick={() => setOpen(true)}>Group whole paths</button>}
    {disabledReason && <p role="status">{disabledReason}</p>}
    {open && <GroupingForm {...props} disabledReason={disabledReason} onClose={() => setOpen(false)} />}
  </section>;
}

function GroupingForm({ document, lockedComponentIds, onEdit, disabledReason, onClose }: Props & { onClose(): void }) {
  const [regions, setRegions] = useState<Region[]>([]), [id, setId] = useState("");
  const [role, setRole] = useState<Region["role"]>("whole_artwork");
  const [bounds, setBounds] = useState<string[]>(() => document.viewBox.map(String));
  const [error, setError] = useState<string | null>(null), [preview, setPreview] = useState<{ base: LogoVectorDocument; componentCount: number } | null>(null);
  const [applied, setApplied] = useState(false), submitted = useRef(false);
  const disabled = Boolean(disabledReason);
  const pathCount = document.components.reduce((total, component) => total + component.paths.length, 0), hasRegions = regions.length > 0;
  // Bounds are needed only after a region is added, not while opening the chooser
  // or typing coordinates. Keep this geometry work separate from image creation.
  const pathBounds = useMemo(() => hasRegions ? flattenLogoPaths(document).map(path => getLogoPathPaintedBounds(path) ?? canonicalizeLogoPath(path.d).getBounds()) : [], [document, hasRegions]);
  const [artworkImage, setArtworkImage] = useState<{ document: LogoVectorDocument; url: string | null; failed: boolean } | null>(null);
  // Keep the full path count inside a passive canonical SVG image, not the React
  // DOM. Each resource belongs to this exact document and this mounted chooser.
  useEffect(() => {
    let disposed = false, url: string | null = null;
    try { url = URL.createObjectURL(new Blob([Uint8Array.from(serializeLogoSvg(document))], { type: "image/svg+xml" })); }
    catch { /* The unavailable state below preserves the source and prevents application. */ }
    const next = { document, url, failed: url === null };
    queueMicrotask(() => { if (!disposed) setArtworkImage(next); });
    return () => { disposed = true; if (url !== null) URL.revokeObjectURL(url); };
  }, [document]);
  // A prop/account replacement must never show the previous document while its
  // replacement effect is preparing an image, even for a single render.
  const image = artworkImage?.document === document ? artworkImage : null;
  const imageReady = Boolean(image?.url && !image.failed);
  const counts = regions.map(region => {
    const [x, y, width, height] = region.bounds;
    return pathBounds.filter(bounds => bounds.minX >= x && bounds.minY >= y && bounds.maxX <= x + width && bounds.maxY <= y + height).length;
  });
  const invalidate = () => { setPreview(null); setError(null); setApplied(false); submitted.current = false; };
  function addRegion() {
    if (disabled || regions.length >= 64) return;
    const values = bounds.map(value => value.trim() === "" ? NaN : Number(value));
    const result = logoManualEditSchema.safeParse({ kind: "group_components", regions: [...regions, { id: id.trim(), role, bounds: values }] });
    if (!result.success || result.data.kind !== "group_components") { setError("Use a unique region ID with letters, numbers, dots, colons, underscores or hyphens, and four complete bounded numbers. Width and height must be positive."); return; }
    setRegions(result.data.regions); setId(""); invalidate();
  }
  function inspect() {
    const result = groupLogoComponents(document, regions);
    const warning = lockedComponentIds.length ? lockWarning(document, result, lockedComponentIds) : null;
    if (warning) throw new Error(warning);
    return result;
  }
  function review() {
    if (disabled || !imageReady || !regions.length) return;
    try { const result = inspect(); setPreview({ base: document, componentCount: result.components.length }); setError(null); setApplied(false); submitted.current = false; }
    catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : "This grouping is unavailable."); }
  }
  function apply() {
    if (disabled || !imageReady || preview?.base !== document || submitted.current) return;
    try {
      inspect(); // Recheck current document and locks, even if props changed after preview.
      submitted.current = true; setApplied(true); setError(null);
      onEdit({ kind: "group_components", regions });
    } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : "This grouping is unavailable."); }
  }
  return <>
    <p>{pathCount} {pathCount === 1 ? "path" : "paths"}. Canvas: {document.viewBox.join(", ")} (X, Y, width, height). Regions use these canvas coordinates.</p>
    <div className={styles.canvas}><svg role="img" aria-label="Grouping selection preview" viewBox={document.viewBox.join(" ")} xmlns="http://www.w3.org/2000/svg">
      <title>Original artwork with selected region outlines</title>
      {imageReady && <image href={image!.url!} x={document.viewBox[0]} y={document.viewBox[1]} width={document.viewBox[2]} height={document.viewBox[3]} preserveAspectRatio="none"
        onError={() => setArtworkImage(current => current?.document === document && current.url === image?.url ? { ...current, failed: true } : current)} />}
      {regions.map(region => <rect key={region.id} aria-label={`Region ${region.id}`} x={region.bounds[0]} y={region.bounds[1]} width={region.bounds[2]} height={region.bounds[3]}
        fill="none" stroke="#A81168" strokeWidth="2" strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />)}
    </svg></div>
    {!image && <p role="status">Preparing the grouping preview…</p>}
    {image?.failed && <p role="alert">The grouping image is unavailable. Close and reopen grouping to try again.</p>}
    <fieldset className={styles.fields} disabled={disabled || regions.length >= 64}>
      <legend>Add a region</legend>
      <label>Region ID<input aria-label="Region ID" maxLength={200} value={id} onChange={event => { setId(event.currentTarget.value); invalidate(); }} placeholder="e.g. wordmark" /></label>
      <label>Region role<select aria-label="Region role" value={role} onChange={event => { setRole(event.currentTarget.value as Region["role"]); invalidate(); }}>
        <option value="whole_artwork">Whole artwork</option><option value="symbol">Symbol</option><option value="lettering">Lettering</option><option value="illustration">Illustration</option><option value="border">Border</option>
      </select></label>
      {(["X", "Y", "width", "height"] as const).map((label, index) => <label key={label}>Region {label}<input aria-label={`Region ${label}`} type="number" step="any"
        min={index < 2 ? -1_000_000 : 0} max={index < 2 ? 1_000_000 : 16_384} value={bounds[index]} onChange={event => { const value = event.currentTarget.value; setBounds(current => current.map((previous, position) => position === index ? value : previous)); invalidate(); }} /></label>)}
      <button type="button" onClick={addRegion}>Add region</button>
    </fieldset>
    <p>Add every remaining path in an affected component. A compound path stays together. Overlapping regions and drawing-order changes are rejected.</p>
    <ul aria-label="Selected grouping regions" style={{ overflowWrap: "anywhere" }}>{regions.map((region, index) => <li key={region.id}>
      <strong>{region.id}</strong> · {region.role.replaceAll("_", " ")} · {counts[index]} whole {counts[index] === 1 ? "path" : "paths"} · [{region.bounds.join(", ")}]
      <button type="button" disabled={disabled} onClick={() => { setRegions(current => current.filter(item => item.id !== region.id)); invalidate(); }}>Remove {region.id}</button>
    </li>)}</ul>
    {regions.length >= 64 && <p role="status">The 64-region limit is reached.</p>}
    {error && <p role="alert">{error}</p>}
    {preview?.base === document && <p role="status">Grouping checked: {preview.componentCount} {preview.componentCount === 1 ? "component" : "components"}. All paths, paint and drawing order are preserved.</p>}
    {applied && <p role="status">Grouping prepared. Save the edit to create its new version.</p>}
    <div className={styles.actions}>
      <button type="button" disabled={disabled || !imageReady || !regions.length} onClick={review}>Preview grouping</button>
      <button type="button" disabled={disabled || !imageReady || preview?.base !== document || applied} onClick={apply}>Apply grouping</button>
      <button type="button" onClick={onClose}>Cancel grouping</button>
    </div>
  </>;
}
