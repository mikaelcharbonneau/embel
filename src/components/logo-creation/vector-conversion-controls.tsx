"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { logoTraceSettingsSchema, type LogoTraceSettings } from "@/domain/logo-vector";
import type { LogoCreationController, LogoCreationState } from "./creation-controller";
import { captureLogoVectorReviewContext, createLogoVectorReviewRequest, type LogoVectorReviewContext } from "./vector-conversion-request";
import { useGenerationEstimate } from "./use-generation-estimate";
import { LogoGenerationAction } from "./generation-action";
import styles from "./logo-creation.module.css";

const EMPTY: LogoCreationState = Object.freeze({ phase: "idle", quote: null, request: null, error: null });
const noSubscription = () => () => undefined;
const emptySnapshot = () => EMPTY;
type SettingsDraft = { preset: LogoTraceSettings["preset"]; simplify: string; filterSpeckle: string; maxColors: string };
const defaults: SettingsDraft = { preset: "bw", simplify: "0", filterSpeckle: "0", maxColors: "2" };
const number = (value: string) => value.trim() ? Number(value) : NaN;

/** Use the quote's immutable settings here, never the editable form values. */
export function LogoVectorSettingsSummary({ settings }: { settings: LogoTraceSettings }) {
  return <p className={styles.note} aria-label="Conversion settings">
    {settings.preset === "bw" ? "Black and white" : "Poster color"} · Maximum colors {settings.maxColors} · Simplification {settings.simplify} · Speckle filtering {settings.filterSpeckle}
  </p>;
}

/** Settings prepare only an estimate. Conversion starts on one deliberate click;
 * accepting the resulting vector remains a separate choice. */
export function LogoVectorConversionControls({ context, getCurrentContext, controller, available, blocked, onRefreshAvailability }: {
  context: LogoVectorReviewContext | null;
  getCurrentContext(): LogoVectorReviewContext | null;
  controller: LogoCreationController | null;
  available: boolean;
  blocked: boolean;
  onRefreshAvailability?: () => void;
}) {
  const [draft, setDraft] = useState<SettingsDraft>(defaults);
  const [changedBeforeClick, setChangedBeforeClick] = useState(false);
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const description = useId(), error = useId();
  const captured = captureLogoVectorReviewContext(context);
  const settings = logoTraceSettingsSchema.safeParse({ preset: draft.preset, simplify: number(draft.simplify), filterSpeckle: number(draft.filterSpeckle), maxColors: number(draft.maxColors) });
  const locked = state.phase !== "idle";
  const invalid = (field: keyof SettingsDraft) => !settings.success && settings.error.issues.some(issue => issue.path[0] === field);
  const canReview = !!controller && !!captured?.source && available && !blocked && !locked && settings.success;

  const request = canReview && settings.success ? createLogoVectorReviewRequest(captured, getCurrentContext(), settings.data) : null;
  const stale = changedBeforeClick || canReview && !request;
  const estimate = useGenerationEstimate(controller, request);

  return <section id="logo-conversion-settings" className={styles.panel} aria-label="Convert selected logo">
    <h2>Convert your selected logo</h2>
    <p className={styles.note}>Adjust these settings to convert or retry the saved selected image. A successful conversion creates a new candidate. The original image, existing candidates and last approved logo are kept.</p>
    <p className={styles.note} id={description}>Higher simplification can reduce path detail and change curves. Speckle filtering can remove small details, including parts of lettering. Fewer colors can merge distinct areas. Compare every result with the original before accepting it; these controls cannot guarantee a faithful match.</p>
    {!captured?.source && <p className={styles.note}>Select and save a logo concept or image refinement first.</p>}
    {!available && <p className={styles.note}>Vector conversion is currently unavailable. Your saved work is kept.</p>}
    <div className={styles.fields}>
      <label className={styles.field}><span>Conversion color mode</span><select aria-label="Conversion color mode" aria-describedby={description} disabled={locked} value={draft.preset}
        onChange={event => { const preset = event.currentTarget.value; if (preset === "bw" || preset === "poster") setDraft(previous => ({ ...previous, preset, maxColors: preset === "bw" ? "2" : previous.maxColors })); }}>
        <option value="bw">Black and white</option><option value="poster">Poster color</option>
      </select></label>
      <label className={styles.field}><span>Maximum colors (2–32)</span><input aria-label="Maximum colors" type="number" min={2} max={32} step={1} disabled={locked || draft.preset === "bw"} value={draft.maxColors} aria-invalid={invalid("maxColors")} aria-describedby={description}
        onChange={event => { const value = event.currentTarget.value; setDraft(previous => ({ ...previous, maxColors: value })); }} />
        {draft.preset === "bw" && <span className={styles.note}>Black and white uses exactly two colors.</span>}
      </label>
      <label className={styles.field}><span>Simplification (0–2.5)</span><input aria-label="Simplification" type="number" min={0} max={2.5} step="any" disabled={locked} value={draft.simplify} aria-invalid={invalid("simplify")} aria-describedby={description}
        onChange={event => { const value = event.currentTarget.value; setDraft(previous => ({ ...previous, simplify: value })); }} /></label>
      <label className={styles.field}><span>Speckle filtering (0–16)</span><input aria-label="Speckle filtering" type="number" min={0} max={16} step={1} disabled={locked} value={draft.filterSpeckle} aria-invalid={invalid("filterSpeckle")} aria-describedby={description}
        onChange={event => { const value = event.currentTarget.value; setDraft(previous => ({ ...previous, filterSpeckle: value })); }} /></label>
    </div>
    {!settings.success && <p id={error} className={styles.warning} role="alert">Enter simplification from 0 to 2.5, whole-number speckle filtering from 0 to 16, and 2 to 32 whole-number colors. Black and white requires exactly two colors.</p>}
    {stale && <p className={styles.warning} role="status">The saved selection or account changed. Refresh the saved brand and review its current selection before converting.</p>}
    <p className={styles.note}>Conversion starts when you choose Convert to vector. Review the result before accepting it. Check an unfinished request before starting another conversion.</p>
    <div className={styles.actions}>
      <LogoGenerationAction estimate={estimate} label="Convert to vector" unavailable={available ? "Save a logo selection and valid settings first." : "Vector conversion is currently unavailable."} onStart={() => {
        if (!settings.success || !createLogoVectorReviewRequest(captured, getCurrentContext(), settings.data)) { setChangedBeforeClick(true); return; }
        setChangedBeforeClick(false); estimate.start();
      }} />
      {onRefreshAvailability && <button className={styles.secondaryButton} type="button" onClick={onRefreshAvailability}>Refresh operation availability</button>}
    </div>
  </section>;
}
