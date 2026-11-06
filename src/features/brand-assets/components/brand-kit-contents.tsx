import { useEffect, useRef, useState } from "react";
import { brandBoardFont } from "@/domain/brand-board-fonts";
import type { BrandAssetFile, PreparedBrandAssets } from "../client/build-pack";
import { BRAND_APPLICATIONS } from "../model/artwork";
import { brandPaletteCss } from "../model/guides";
import type { BrandAssetSnapshot } from "../model/snapshot";
import styles from "./brand-assets.module.css";

type BrandKitContentsProps = {
  snapshot: BrandAssetSnapshot;
  pack: PreparedBrandAssets | null;
  previews: ReadonlyMap<string, string> | undefined;
  downloadFile(file: BrandAssetFile): void;
  disabled: boolean;
};

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

export function BrandKitContents({ snapshot, pack, previews, downloadFile, disabled }: BrandKitContentsProps) {
  const files = pack?.files ?? [];
  const board = files.find(file => file.category === "board");
  const boardPreview = board && previews?.get(board.name);
  function button(file: BrandAssetFile) {
    return <button key={file.name} type="button" disabled={disabled} onClick={() => downloadFile(file)}>{downloadLabel(file)}</button>;
  }
  function buttons(category: BrandAssetFile["category"]) {
    const matches = files.filter(file => file.category === category);
    return matches.length > 0 && <div className={styles.actions}>{matches.map(button)}</div>;
  }
  return <>
    <div className={styles.foundation}>
      <KitPalette colors={snapshot.colors} />
      <section><h3>Typography</h3>
        <dl className={styles.typeList}>{snapshot.typography.map(style => {
          const font = brandBoardFont(style.family);
          return <div key={style.key}><dt>{style.role}</dt><dd>
            {font ? <a href={font.url} target="_blank" rel="noreferrer">{style.family}</a> : style.family}
            <span>{style.weight}{style.style !== "normal" && ` · ${style.style}`}</span>
          </dd></div>;
        })}</dl>
      </section>
    </div>

    <div className={boardPreview ? styles.overview : styles.inventory}>
      {board && boardPreview && <figure className={styles.board}>
        {/* eslint-disable-next-line @next/next/no-img-element -- The preview is the prepared file's local object URL. */}
        <img src={boardPreview} alt={`${snapshot.name} final brand board`} />
        <figcaption><span>{board.label}</span>{button(board)}</figcaption>
      </figure>}
      <div className={styles.files}>
        {!boardPreview && <section><h3>Brand board</h3><p>A one-page reference for your logo, palette and typography.</p>{board && button(board)}</section>}
        <section><h3>Logo files</h3><p>{pack?.vectorIncluded ? "Original logo artwork and its matching saved vector." : "Original logo artwork in its saved image format."}</p>{buttons("logo")}</section>
        <section><h3>Selected direction</h3><p>The original direction board for visual reference.</p>{buttons("direction")}</section>
        <section><h3>Brand guide</h3><p>Color values, CSS variables, font links and notes on using your files.</p>{buttons("guide")}</section>
      </div>
    </div>

    <section className={styles.social}><h3>Social images and templates</h3>
      <p>Use the PNGs as images, or edit the text, colors and shapes in an SVG template.</p>
      <div className={pack ? styles.gallery : styles.formats}>{BRAND_APPLICATIONS.map(spec => {
        const png = files.find(file => file.name === `social/${spec.id}.png`);
        const svg = files.find(file => file.name === `social/${spec.id}.svg`);
        if (pack && !png && !svg) return null;
        const preview = png && previews?.get(png.name);
        return <article className={styles.card} key={spec.id}>
          {preview && png && <div className={styles.artwork}>
            {/* eslint-disable-next-line @next/next/no-img-element -- The preview is the prepared file's local object URL. */}
            <img src={preview} alt={`${snapshot.name} ${png.label.toLowerCase()}`} />
          </div>}
          <div className={styles.cardBody}><h4>{png?.label ?? spec.label}</h4>
            <p>{png?.width ?? spec.width} × {png?.height ?? spec.height}{!pack && (spec.editable ? " · PNG + SVG" : " · PNG")}</p>
            {(png || svg) && <div className={styles.actions}>{png && button(png)}{svg && button(svg)}</div>}
          </div>
        </article>;
      })}</div>
    </section>
  </>;
}
