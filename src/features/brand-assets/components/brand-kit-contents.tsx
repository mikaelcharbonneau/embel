import { useEffect, useRef, useState } from "react";
import type { BrandAssetFile } from "../client/build-pack";
import { brandPaletteCss } from "../model/guides";
import type { BrandAssetSnapshot } from "../model/snapshot";
import styles from "./brand-assets.module.css";

export function fileFormat(file: BrandAssetFile) {
  switch (file.mimeType) {
    case "image/png":
      return "PNG";
    case "image/jpeg":
      return "JPG";
    case "image/webp":
      return "WEBP";
    case "image/svg+xml":
      return "SVG";
    case "text/html":
      return "HTML";
    case "application/json":
      return "JSON";
    case "text/css":
      return "CSS";
    case "text/plain":
      return "TXT";
    default:
      return file.label;
  }
}
/** Visible button text, e.g. "Download PNG"; the accessible name adds the item. */
export const downloadLabel = (file: BrandAssetFile) => `Download ${fileFormat(file)}`;
/** Logo files sit side by side, so their visible text names which logo each is.
 * Only the verified saved vector is ever called a vector. */
export function logoDownloadLabel(file: BrandAssetFile) {
  const kind =
    (
      {
        "logo/logo-transparent.png": "transparent logo",
        "logo/logo-reversed.png": "reversed logo",
        "logo/logo-vector.svg": "vector logo",
      } as Record<string, string>
    )[file.name] ?? "logo";
  return `Download ${kind} ${fileFormat(file)}`;
}

type CopyFeedback = { key: string | null; text: string; copied: boolean };

export function KitPalette({ colors }: Pick<BrandAssetSnapshot, "colors">) {
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null);
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );
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
    } catch {
      /* Keep the same text available for manual copying. */
    }
    if (latest.current === request) setFeedback({ key, text, copied });
  }

  return (
    <div className={styles.palette}>
      <ul className={styles.swatches}>
        {colors.map((color) => (
          <li key={color.key}>
            <button
              type="button"
              aria-label={`Copy ${color.name} ${color.hex}`}
              title={`Copy ${color.hex}`}
              onClick={() => void copy(color.key, color.hex)}
            >
              <span className={styles.chip} style={{ backgroundColor: color.hex }} aria-hidden="true" />
              <span>
                {color.name}
                <small>{feedback?.copied && feedback.key === color.key ? "Copied" : color.hex}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div>
        <button
          type="button"
          className="button secondary small"
          aria-label="Copy CSS palette"
          onClick={() => void copy(null, brandPaletteCss(colors))}
        >
          {feedback?.copied && feedback.key === null ? "Copied" : "Copy CSS palette"}
        </button>
      </div>
      <span className={feedback && !feedback.copied ? styles.manualCopy : "sr-only"} role="status">
        {feedback &&
          (feedback.copied
            ? feedback.key === null
              ? "CSS palette copied."
              : `Copied ${feedback.text}.`
            : "Clipboard unavailable. Select and copy the text below.")}
      </span>
      {feedback && !feedback.copied && (
        <label className={styles.manualCopy}>
          <span className="sr-only">{feedback.key === null ? "CSS palette" : "Hex value"}</span>
          <textarea
            readOnly
            rows={feedback.key === null ? Math.min(colors.length + 2, 6) : 1}
            value={feedback.text}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </div>
  );
}
