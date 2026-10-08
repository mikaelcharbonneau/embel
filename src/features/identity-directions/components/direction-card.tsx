"use client";

import Image from "next/image";
import { useState } from "react";
import type { FontRecord, IdentityDirectionVersion, IdentityGraphicsVersion, IdentityPaletteVersion, IdentityTypographyVersion } from "@/domain/logo-directions";
import type { LogoVectorDocument } from "@/domain/logo-vector";
import { flattenLogoPaths, validateLogoVectorDocument } from "@/features/logo-vector/model/geometry";
import { prepareDirectionGraphicsPreview } from "../model/graphics-preview";
import { FontPicker } from "./font-picker";
import styles from "./identity-directions.module.css";
import graphicsStyles from "./graphics-preview.module.css";

export type DirectionCardProps = {
  direction: IdentityDirectionVersion;
  palette: IdentityPaletteVersion | null;
  typography: IdentityTypographyVersion | null;
  graphics: IdentityGraphicsVersion | null;
  fonts: readonly FontRecord[];
  selectedParts: readonly ("palette" | "typography" | "graphics")[];
  stale: boolean;
  approvedLogoDocument?: LogoVectorDocument | null;
  onChoose?: () => void;
  disabled?: boolean;
};

function GraphicsPreviewImage({ src, name, stale }: { src: string; name: string; stale: boolean }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) return <p className={styles.caption}>Graphic preview unavailable · the image could not be displayed. Saved specifications are shown below.</p>;
  return <><Image unoptimized src={src} width={256} height={160} className={graphicsStyles.image}
    alt={"Supporting graphics for " + name + (stale ? " (earlier inputs)" : "")} onError={() => setFailed(true)} />
    <p className={styles.caption}>Preview of saved specifications</p></>;
}

export function DirectionCard({ direction, palette, typography, graphics, fonts, selectedParts, stale, approvedLogoDocument, onChoose, disabled }: DirectionCardProps): React.JSX.Element {
  let document: LogoVectorDocument | null = null;
  try { if (approvedLogoDocument) document = validateLogoVectorDocument(approvedLogoDocument); } catch { /* Remain explicitly unavailable. */ }
  const paths = document ? flattenLogoPaths(document) : [];
  const graphicsPreview = prepareDirectionGraphicsPreview(direction, graphics, palette);
  return <article className={styles.card} aria-labelledby={"direction-" + direction.id}>
    <header className={styles.cardHeader}><h3 id={"direction-" + direction.id}>{direction.name}</h3>
      {stale && <span className={styles.warningBadge}>Earlier inputs</span>}
      {selectedParts.length > 0 && <p className={styles.caption}>Chosen components: {selectedParts.join(", ")}</p>}
    </header>
    {document ? <div className={styles.logoPreview}><svg role="img" aria-label="Approved logo, unchanged" viewBox={document.viewBox.join(" ")}>{paths.map(path => <path key={path.id} d={path.d} fill={path.fill?.color ?? "none"} fillOpacity={path.fill?.opacity} fillRule={path.fillRule} stroke={path.stroke?.color ?? "none"} strokeWidth={path.stroke?.width} strokeOpacity={path.stroke?.opacity} strokeLinecap={path.stroke?.linecap} strokeLinejoin={path.stroke?.linejoin} strokeMiterlimit={path.stroke?.miterLimit} />)}</svg></div> : <div className={styles.logoUnavailable}><strong>Logo preview unavailable</strong><p>The verified approved artwork cannot be loaded here.</p></div>}
    {onChoose && <button type="button" disabled={disabled} onClick={onChoose} aria-label={"Choose " + direction.name}>Choose this direction</button>}
    {palette ? <>
      <div className={styles.swatches} aria-label="Saved palette">{palette.swatches.map(swatch => <div key={swatch.key} className={styles.swatch}>
        <span className={styles.colorChip} style={{ backgroundColor: swatch.color.hex }} aria-hidden="true" /><span>{swatch.name}</span><code>{swatch.color.hex}</code>
      </div>)}</div>
      <details className={styles.details}><summary>Color values</summary><dl className={styles.colorValues}>{palette.swatches.map(swatch => <div key={swatch.key}>
        <dt>{swatch.name}</dt><dd><code>{swatch.color.hex}</code><span>RGB {swatch.color.rgb.join(", ")}</span>
          {swatch.color.cmyk.status === "unavailable" ? <span>CMYK unavailable · no print profile</span> : <><span>CMYK {swatch.color.cmyk.channels.join(" / ")}%</span><span>Profile: {swatch.color.cmyk.profileId}</span><span>{swatch.color.cmyk.limitations.join(" ")}</span></>}
          {swatch.color.pantone.status === "unavailable" ? <span>Pantone unavailable · no licensed matching source</span> : <><span>Approximate Pantone reference: {swatch.color.pantone.reference}</span><span>{swatch.color.pantone.limitations.join(" ")}</span></>}
        </dd></div>)}</dl></details>
    </> : <p className={styles.caption}>This palette is unavailable.</p>}
    <details className={styles.details}><summary>Typography</summary><FontPicker typography={typography} fonts={fonts} /></details>
    <details className={styles.details}><summary>Supporting graphics</summary>
      {graphicsPreview.status === "ready"
        ? <GraphicsPreviewImage key={graphicsPreview.key} src={graphicsPreview.src} name={direction.name} stale={stale} />
        : <p className={styles.caption}>{graphicsPreview.message}</p>}
      {graphicsPreview.elements.length > 0 && <ul className={styles.graphicList}>{graphicsPreview.elements.map((element, index) => <li key={index}>
          {element.kind === "dots" ? "Dots · radius " + element.radius + ", spacing " + element.spacing : element.kind === "stripes" ? "Stripes · width " + element.width + ", spacing " + element.spacing + ", rotation " + element.rotation + "°" : element.shape + " · " + element.width + " × " + element.height}
          <span>Color: {element.paletteKey}</span>
        </li>)}</ul>}
    </details>
    <details className={styles.details}><summary>Saved versions</summary><dl className={styles.versions}>
      <div><dt>Direction</dt><dd>{direction.id}</dd></div><div><dt>Approved logo</dt><dd>{direction.approvedLogoId}</dd></div>
      <div><dt>Palette</dt><dd>{direction.paletteVersionId}</dd></div><div><dt>Typography</dt><dd>{direction.typographyVersionId}</dd></div><div><dt>Graphics</dt><dd>{direction.graphicsVersionId}</dd></div>
    </dl></details>
  </article>;
}
