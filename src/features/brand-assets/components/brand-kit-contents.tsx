import { useEffect, useRef, useState } from "react";
import type { BrandAssetFile } from "../client/build-pack";
import { brandPaletteCss } from "../model/guides";
import type { BrandAssetSnapshot } from "../model/snapshot";
import styles from "./brand-assets.module.css";

export function downloadLabel(file: BrandAssetFile) {
  if (file.editable) return "Editable SVG";
  switch (file.mimeType) {
    case "image/png": return "Download PNG";
    case "image/jpeg": return "Download JPG";
    case "image/webp": return "Download WEBP";
    case "image/svg+xml": return "Download SVG";
    case "text/html": return "Download guide";
    case "application/json": return "Color values · JSON";
    case "text/css": return "Color variables · CSS";
    case "text/plain": return "Readme · TXT";
    default: return file.label;
  }
}

type CopyFeedback = { key: string | null; text: string; copied: boolean };

export function KitPalette({ colors }: Pick<BrandAssetSnapshot, "colors">) {
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null);
  const latest = useRef(0);
  useEffect(() => () => { latest.current++; }, []);
  useEffect(() => {
    if (!feedback?.copied) return;
    const timer = setTimeout(() => setFeedback(null), 1800);
    return () => clearTimeout(timer);
  }, [feedback]);

  async function copy(key: string | null, text: string) {
    const request = ++latest.current;
    setFeedback(null);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch { /* Keep the same text available for manual copying. */ }
    if (latest.current === request) setFeedback({ key, text, copied });
  }

  return <section>
    <div className={styles.paletteHeading}>
      <h3>Color palette</h3>
      <button type="button" className={styles.copyPalette} aria-label="Copy CSS palette" onClick={() => void copy(null, brandPaletteCss(colors))}>
        {feedback?.copied && feedback.key === null ? "Copied" : "Copy CSS palette"}
      </button>
    </div>
    <ul className={styles.swatches}>{colors.map(color => <li key={color.key}>
      <button type="button" aria-label={`Copy ${color.name} ${color.hex}`} title={`Copy ${color.hex}`} onClick={() => void copy(color.key, color.hex)}>
        <span className={styles.chip} style={{ backgroundColor: color.hex }} aria-hidden="true" />
        <span>{color.name}<small>{feedback?.copied && feedback.key === color.key ? "Copied" : color.hex}</small></span>
      </button>
    </li>)}</ul>
    <span className={feedback && !feedback.copied ? styles.manualCopy : "sr-only"} role="status">
      {feedback && (feedback.copied ? (feedback.key === null ? "CSS palette copied." : `Copied ${feedback.text}.`) : "Clipboard unavailable. Select and copy the text below.")}
    </span>
    {feedback && !feedback.copied && <label className={styles.manualCopy}><span className="sr-only">{feedback.key === null ? "CSS palette" : "Hex value"}</span>
      <textarea readOnly rows={feedback.key === null ? Math.min(colors.length + 2, 6) : 1} value={feedback.text} onFocus={event => event.currentTarget.select()} />
    </label>}
  </section>;
}
