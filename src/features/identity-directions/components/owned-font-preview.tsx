"use client";

import { useEffect, useRef, useState } from "react";
import type { FontRecord, IdentityTypographyVersion } from "@/domain/logo-directions";
import { fontPurposeAllowed } from "../model/font-rights";
import { fontPreviewInputSchema, validateFontPreviewGeometry, type FontPreviewReader, type FontPreviewResult, type FontPreviewUnavailable } from "../model/font-preview";
import styles from "./identity-directions.module.css";

const explanations: Record<FontPreviewUnavailable, string> = {
  sample_unsupported: "Preview unavailable. This specimen needs an unsupported text layout or exceeds the 200-character single-line preview limit.",
  style_unsupported: "Preview unavailable. The saved weight or italic style is not supported by this exact font file.",
  missing_glyphs: "Preview unavailable. This font is missing characters in the saved specimen.",
  outline_permission_required: "Preview unavailable. Reviewed display and outline permissions are required.",
};

/** The parent keys this component by the complete font and specimen identity.
 * Geometry remains in component memory only; no font bytes or object URLs exist. */
type Props = { font: FontRecord; style: IdentityTypographyVersion["styles"][number]; readPreview?: FontPreviewReader };
export function OwnedFontPreview(props: Props): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(false);
  useEffect(() => {
    const disclosures: HTMLDetailsElement[] = [];
    for (let parent = container.current?.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) disclosures.push(parent);
    const update = () => setVisible(disclosures.every(details => details.open));
    disclosures.forEach(details => details.addEventListener("toggle", update));
    update();
    return () => disclosures.forEach(details => details.removeEventListener("toggle", update));
  }, []);
  // Closed typography/history disclosures do not start font reads or shaping.
  return <div ref={container}>{visible && <FontSpecimen {...props} />}</div>;
}
function FontSpecimen({ font, style, readPreview }: Props): React.JSX.Element {
  const [source] = useState(() => ({ font, input: fontPreviewInputSchema.parse({ sampleText: style.sampleText, weight: style.weight, style: style.style, sizePx: style.sizePx, lineHeight: style.lineHeight, fontContentHash: font.asset.contentHash, rightsEvidenceId: font.rights.id }) }));
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ reader: FontPreviewReader; attempt: number; result: FontPreviewResult | null; failed: boolean } | null>(null);
  const permitted = fontPurposeAllowed(source.font, "render") && fontPurposeAllowed(source.font, "outline");
  useEffect(() => {
    if (!readPreview || !permitted) return;
    const controller = new AbortController();
    void readPreview(source.font, source.input, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result?.status === "ready") result = { status: "ready", document: validateFontPreviewGeometry(result.document) };
      setState({ reader: readPreview, attempt, result, failed: false });
    }).catch(() => { if (!controller.signal.aborted) setState({ reader: readPreview, attempt, result: null, failed: true }); });
    return () => controller.abort();
  }, [readPreview, source, permitted, attempt]);
  if (!permitted) return <p className={styles.caption}>{explanations.outline_permission_required}</p>;
  if (!readPreview) return <p className={styles.caption}>Preview unavailable. A verified account font source is required.</p>;
  const visible = state?.reader === readPreview && state.attempt === attempt ? state : null;
  if (!visible) return <p className={styles.caption} role="status">Loading font specimen…</p>;
  if (visible.failed || !visible.result) return <div><p className={styles.caption} role="status">Font specimen could not be loaded.</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry font preview</button></div>;
  if (visible.result.status === "unavailable") return <p className={styles.caption}>{explanations[visible.result.reason]}</p>;
  const document = visible.result.document;
  return <figure style={{ margin: 0, minWidth: 0 }}>
    <svg role="img" aria-label={`${style.role} font specimen: ${style.sampleText}`} viewBox={document.viewBox.join(" ")} style={{ display: "block", width: "100%", height: "auto", maxHeight: "160px", background: "#fff" }}>
      {document.components[0]!.paths.map(path => <path key={path.id} d={path.d} fill="#000000" fillRule={path.fillRule} />)}
    </svg>
    <figcaption className={styles.caption}>Exact font specimen · scaled to fit</figcaption>
  </figure>;
}
