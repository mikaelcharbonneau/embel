import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { BrandAssetFile } from "../client/build-pack";
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

type Failed = { key: string; label: string; text: string };

/** Copies text and confirms with a toast only after the clipboard accepted it.
 * When it is refused, the same text is offered for copying by hand. */
export function useCopy() {
  const toast = useToast();
  const [failed, setFailed] = useState<Failed | null>(null);
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );
  const copy = useCallback(
    async (key: string, label: string, text: string, confirmation: string) => {
      const request = ++latest.current;
      setFailed(null);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        if (latest.current === request) setFailed({ key, label, text });
        return;
      }
      if (latest.current === request) toast(confirmation);
    },
    [toast],
  );
  return { copy, failed, dismiss: () => setFailed(null) };
}

/** The text the clipboard refused, selectable for copying by hand. */
export function ManualCopy({ failed }: { failed: Failed | null }) {
  return (
    <>
      <span className={failed ? styles.manualCopy : "e-sr"} role="status">
        {failed ? "Clipboard unavailable. Select and copy the text below." : ""}
      </span>
      {failed && (
        <label className={styles.manualCopy}>
          <span className="e-sr">{failed.label}</span>
          <textarea
            readOnly
            rows={Math.min(failed.text.split("\n").length, 8)}
            value={failed.text}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </>
  );
}

/** The brand's colors with their use and a copy action each (ColorSwatch). */
export function ColorSwatches({
  colors,
}: {
  colors: readonly { key: string; name: string; hex: string; use: string }[];
}) {
  const { copy, failed } = useCopy();
  return (
    <>
      <ul className={`e-grid-fields ${styles.list}`}>
        {colors.map((color) => (
          <li key={color.key} className="e-swatch">
            <span className="e-swatch__color" style={{ background: color.hex }} role="img" aria-label={color.hex} />
            <span className="e-swatch__text">
              <span className="e-swatch__name">
                {color.name} · <span className="e-muted">{color.use}</span>
              </span>
              <span className="e-swatch__value">{color.hex}</span>
            </span>
            <IconButton
              icon="copy"
              size="sm"
              label={`Copy ${color.name} ${color.hex}`}
              onClick={() => void copy(color.key, `${color.name} value`, color.hex, `Copied ${color.hex}`)}
            />
          </li>
        ))}
      </ul>
      <ManualCopy failed={failed} />
    </>
  );
}
