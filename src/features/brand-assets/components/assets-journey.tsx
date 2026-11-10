"use client";

import Link from "next/link";
import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { brandBoardContrastRatio as contrast } from "@/domain/brand-board-design";
import { brandBoardFont } from "@/domain/brand-board-fonts";
import { guidedSlogan } from "@/domain/guided-interview";
import { journeyPartLabel } from "@/domain/journey";
import type { ContextSnapshot } from "@/domain/projects";
import { EmbelIdentity } from "@/components/workspace/embel-identity";
import type { BrandAssetFile, PreparedBrandAssets } from "../client/build-pack";
import { BRAND_APPLICATIONS, logoSurfaces } from "../model/artwork";
import {
  CORNERS,
  designTokens,
  designTokensCss,
  designTokensJson,
  readableBrandColor,
  SPACING,
  TYPE_SCALE,
} from "../model/design-tokens";
import { plainBrandNotes } from "../model/guides";
import type { BrandAssetSnapshot } from "../model/snapshot";
import { downloadLabel, fileFormat, KitPalette, logoDownloadLabel } from "./brand-kit-contents";
import styles from "./brand-assets.module.css";

type Props = {
  snapshot: BrandAssetSnapshot;
  pack: PreparedBrandAssets | null;
  previews: ReadonlyMap<string, string> | undefined;
  downloadFile(file?: BrandAssetFile): void;
  disabled: boolean;
  projectId: string;
  context: ContextSnapshot | null;
  directionTitle?: string;
  /** Progress of preparing or downloading the kit, announced politely. */
  status: string;
};
type TypeStyle = BrandAssetSnapshot["heading"];

function saveText(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The chosen fonts are bundled with the app, so previews use the real type. */
function FontFaces({ snapshot }: { snapshot: BrandAssetSnapshot }) {
  const faces = [snapshot.heading, snapshot.body]
    .map((style) => brandBoardFont(style.family))
    .filter((font, index, all) => font && all.findIndex((other) => other?.id === font.id) === index);
  return (
    <style>
      {faces
        .map(
          (font) =>
            `@font-face{font-family:"${font!.family}";src:url("${font!.file}");font-weight:${font!.minWeight} ${font!.maxWeight};font-display:swap;}`,
        )
        .join("")}
    </style>
  );
}

/** Shows a prepared file's own bytes through a local object URL that lives
 * exactly as long as the image element. */
function FileImage({ file, alt }: { file: BrandAssetFile; alt: string }) {
  const show = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) return;
      const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType }));
      image.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [file],
  );
  return <img ref={show} alt={alt} />; // eslint-disable-line @next/next/no-img-element
}

/** Ends a sentence after a quotation without doubling its own punctuation. */
const quotedEnding = (quote: string) => (/[.!?…。！？]["'”’)]*$/u.test(quote) ? "" : ".");

/** Assets: a summary with the whole kit, then Brand images, Brand guidelines and
 * the Design system, each as one of Embel's messages, built only from the saved
 * brand and the chosen direction. */
export function AssetsJourney({
  snapshot,
  pack,
  previews,
  downloadFile,
  disabled,
  projectId,
  context,
  directionTitle,
  status,
}: Props) {
  const files = pack?.files ?? [];
  const tokens = useMemo(() => designTokens(snapshot), [snapshot]);
  const [format, setFormat] = useState<"css" | "json">("css");
  const slogan = context ? guidedSlogan(context) : null;
  const positioning = context?.positioning || null;
  const p = snapshot.palette,
    surfaces = logoSurfaces(snapshot);
  const colorName = (hex: string) =>
    snapshot.colors.find((color) => color.hex.toLowerCase() === hex.toLowerCase())?.name ?? hex;
  const fileButton = (file: BrandAssetFile, item: string) => (
    <button
      key={file.name}
      type="button"
      className="button secondary small"
      disabled={disabled}
      aria-label={`Download ${item} as ${file.editable ? "editable " : ""}${fileFormat(file)}`}
      onClick={() => downloadFile(file)}
    >
      {downloadLabel(file)}
    </button>
  );
  const logoFiles = files.filter((file) => file.category === "logo");
  // The prepared logo files' own bytes are shown, so the page matches the downloads.
  const logoFile = logoFiles.find((file) => file.name === "logo/logo-transparent.png");
  const reversedFile = logoFiles.find((file) => file.name === "logo/logo-reversed.png");
  const guide = files.find((file) => file.category === "guide" && file.mimeType === "text/html");
  const board = files.find((file) => file.category === "board");
  const boardPreview = board ? previews?.get(board.name) : undefined;
  const base = `/brands/account/${projectId}`;
  const audience = context?.audienceSegments.filter((item) => item.selected).map((item) => item.label) ?? [];
  const heading = {
    fontFamily: `"${snapshot.heading.family}", system-ui, sans-serif`,
    fontWeight: snapshot.heading.weight,
  };
  const body = { fontFamily: `"${snapshot.body.family}", system-ui, sans-serif`, fontWeight: snapshot.body.weight };
  const typePair: [string, TypeStyle, CSSProperties][] = [
    ["Headings", snapshot.heading, heading],
    ["Body", snapshot.body, body],
  ];
  const traits = context?.personality
    ? Object.entries(context.personality)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([key]) => key)
    : [];
  const exportText = format === "css" ? designTokensCss(tokens) : designTokensJson(tokens);
  const inDirection = directionTitle ? `in your chosen direction, ${directionTitle}` : "in your chosen direction";
  // The accent is shown as text only where it is readable; otherwise as a fill.
  const accentReadable = contrast(p.accent, p.background) >= 4.5;

  return (
    <div className="kit-journey">
      <FontFaces snapshot={snapshot} />

      <div className={styles.summary}>
        <div>
          <h2 className={styles.summaryTitle}>Your brand kit</h2>
          <p>
            Logo files, brand images, guidelines and design tokens for {snapshot.name}, {inDirection}.
          </p>
        </div>
        <div className={styles.summaryAction}>
          <button type="button" className="button primary" disabled={disabled} onClick={() => downloadFile()}>
            Download brand kit
          </button>
          <p className={styles.status} role="status">
            {status}
          </p>
        </div>
      </div>

      <article id="assets-images" className="guided-assistant-message kit-message" aria-label="Brand images">
        <EmbelIdentity label={journeyPartLabel("assets", "Brand images")} />
        <p className="guided-assistant-copy">
          {snapshot.name} is coming together. Here are your brand images {inDirection}: a brand board with your logo,
          colors and type on one page, and images for your social accounts. Download any of them, or the whole kit.
        </p>
        {board && (
          <section className="kit-card" aria-labelledby="assets-board-title">
            <h2 id="assets-board-title" className={styles.cardTitle}>
              Brand board
            </h2>
            <figure className="kit-image kit-board">
              <div className="kit-image-frame">
                {boardPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={boardPreview} alt={`${snapshot.name} final brand board`} />
                ) : (
                  <span role="status">Preparing…</span>
                )}
              </div>
              <figcaption className={styles.caption}>
                <span>
                  <strong>Your logo, colors and type on one page</strong>
                </span>
                <span className="kit-actions">{fileButton(board, "brand board")}</span>
              </figcaption>
            </figure>
          </section>
        )}
        <section className="kit-card" aria-labelledby="assets-social-title">
          <h2 id="assets-social-title" className={styles.cardTitle}>
            Social images and templates
          </h2>
          <p className="kit-hint">Posts and banners also come as editable SVG templates.</p>
          <div className="kit-images">
            {BRAND_APPLICATIONS.map((spec) => {
              const png = files.find((file) => file.name === `social/${spec.id}.png`);
              const svg = files.find((file) => file.name === `social/${spec.id}.svg`);
              const preview = png && previews?.get(png.name);
              return (
                <figure key={spec.id} className="kit-image" data-wide={spec.width / spec.height > 1.5}>
                  <div className="kit-image-frame" style={{ aspectRatio: `${spec.width} / ${spec.height}` }}>
                    {preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={preview} alt={`${snapshot.name} ${spec.label.toLowerCase()}`} />
                    ) : (
                      <span role="status">{pack ? "Not available" : "Preparing…"}</span>
                    )}
                  </div>
                  <figcaption className={styles.caption}>
                    <span>
                      <strong>{spec.label}</strong>
                      <small>
                        {spec.width} × {spec.height}
                      </small>
                    </span>
                    <span className="kit-actions">
                      {png && fileButton(png, spec.label.toLowerCase())}
                      {svg && fileButton(svg, spec.label.toLowerCase())}
                    </span>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
        <div className="kit-footer">
          <span>{BRAND_APPLICATIONS.length} social images · Next: Brand guidelines</span>
          <a className="button primary" href="#assets-guidelines">
            Continue
          </a>
        </div>
      </article>

      <article id="assets-guidelines" className="guided-assistant-message kit-message" aria-label="Brand guidelines">
        <EmbelIdentity label={journeyPartLabel("assets", "Brand guidelines")} />
        <p className="guided-assistant-copy">
          Here are your brand guidelines: everything someone needs to use {snapshot.name} consistently. Edit takes you
          to the step that sets each part.
        </p>
        <nav className="kit-sections" aria-label="Guideline sections">
          {["Overview", "Logo", "Colors", "Typography", "Voice", "Imagery"].map((name) => (
            <a key={name} href={`#g-${name.toLowerCase()}`}>
              {name}
            </a>
          ))}
        </nav>
        <section className="kit-card kit-document" aria-labelledby="assets-guidelines-title">
          <h2 id="assets-guidelines-title" className={styles.cardTitle}>
            Brand guidelines
          </h2>
          <section id="g-overview">
            <div className="kit-section-head">
              <h3>Overview</h3>
              <Link href={`${base}?view=strategy#journey-strategy`}>Edit</Link>
            </div>
            <p className="kit-brand-name" style={heading}>
              {snapshot.name}
            </p>
            {slogan && (
              <p className="kit-slogan" style={body}>
                {slogan}
              </p>
            )}
            {(positioning || audience.length > 0) && (
              <dl>
                {positioning && (
                  <div>
                    <dt>Positioning</dt>
                    <dd>{positioning}</dd>
                  </div>
                )}
                {audience.length > 0 && (
                  <div>
                    <dt>Audience</dt>
                    <dd>{audience.join(" · ")}</dd>
                  </div>
                )}
              </dl>
            )}
          </section>
          <section id="g-logo">
            <div className="kit-section-head">
              <h3>Logo</h3>
              <Link href={`${base}/logo`}>Edit</Link>
            </div>
            <div className={styles.logoTiles}>
              <figure className={styles.logoTile}>
                <div className={styles.logoSurface} style={{ background: surfaces.light }}>
                  {logoFile ? (
                    <FileImage file={logoFile} alt={`${snapshot.name} logo on ${colorName(surfaces.light)}`} />
                  ) : (
                    !pack && <span role="status">Preparing…</span>
                  )}
                </div>
                <figcaption>On light backgrounds</figcaption>
              </figure>
              {surfaces.dark && (
                <figure className={styles.logoTile}>
                  <div className={styles.logoSurface} data-tone="dark" style={{ background: surfaces.dark }}>
                    {reversedFile ? (
                      <FileImage
                        file={reversedFile}
                        alt={`${snapshot.name} logo, one-color reversed version on ${colorName(surfaces.dark)}`}
                      />
                    ) : (
                      !pack && <span role="status">Preparing…</span>
                    )}
                  </div>
                  <figcaption>Reversed version, for dark backgrounds</figcaption>
                </figure>
              )}
            </div>
            <p>
              Give the logo clear space and keep it away from other text and images. On light backgrounds, use the copy
              with a transparent background; on dark backgrounds, the one-color reversed version. Don’t stretch the logo
              or change its colors otherwise.
            </p>
            {logoFiles.length > 0 && (
              <div className="kit-actions">
                {logoFiles.map((file) => (
                  <button
                    key={file.name}
                    type="button"
                    className="button secondary small"
                    disabled={disabled}
                    onClick={() => downloadFile(file)}
                  >
                    {logoDownloadLabel(file)}
                  </button>
                ))}
              </div>
            )}
          </section>
          <section id="g-colors">
            <div className="kit-section-head">
              <h3>Colors</h3>
              <Link href={`${base}/logo/directions`}>Edit</Link>
            </div>
            <KitPalette colors={snapshot.colors} />
            {snapshot.colorNotes && <p>{plainBrandNotes(snapshot, snapshot.colorNotes)}</p>}
          </section>
          <section id="g-typography">
            <div className="kit-section-head">
              <h3>Typography</h3>
              <Link href={`${base}/logo/directions`}>Edit</Link>
            </div>
            <div className="kit-type-pair">
              {typePair.map(([role, style, css]) => {
                const font = brandBoardFont(style.family);
                return (
                  <div key={role}>
                    <div className="kit-section-head">
                      <span>
                        {role} · {style.family} {style.weight}
                      </span>
                      {font && (
                        <a href={font.url} target="_blank" rel="noopener noreferrer">
                          Font link ↗
                        </a>
                      )}
                    </div>
                    <p style={css}>
                      {role === "Headings"
                        ? (slogan ?? snapshot.name)
                        : positioning || `${snapshot.name}, set in its body type.`}
                    </p>
                  </div>
                );
              })}
            </div>
            {snapshot.typeNotes && <p>{plainBrandNotes(snapshot, snapshot.typeNotes)}</p>}
          </section>
          <section id="g-voice">
            <div className="kit-section-head">
              <h3>Voice</h3>
              <Link href={`${base}?view=strategy#journey-voice`}>Edit</Link>
            </div>
            {traits.length ? (
              <p>
                Leads with {traits.join(" and ")}
                {slogan ? (
                  <>
                    , as in “{slogan}”{quotedEnding(slogan)}
                  </>
                ) : (
                  "."
                )}
              </p>
            ) : (
              <p>Set the personality in Voice to describe how {snapshot.name} sounds.</p>
            )}
          </section>
          <section id="g-imagery">
            <div className="kit-section-head">
              <h3>Imagery</h3>
              <Link href={`${base}/logo/directions`}>Edit</Link>
            </div>
            {snapshot.graphicNotes && <p>{plainBrandNotes(snapshot, snapshot.graphicNotes)}</p>}
            {snapshot.compositionNotes && <p>{plainBrandNotes(snapshot, snapshot.compositionNotes)}</p>}
          </section>
        </section>
        <div className="kit-footer">
          <span>Next: Design system</span>
          {guide && (
            <button type="button" className="button secondary" disabled={disabled} onClick={() => downloadFile(guide)}>
              Download guidelines
            </button>
          )}
          <a className="button primary" href="#assets-system">
            Continue
          </a>
        </div>
      </article>

      <article id="assets-system" className="guided-assistant-message kit-message" aria-label="Design system">
        <EmbelIdentity label={journeyPartLabel("assets", "Design system")} />
        <p className="guided-assistant-copy">
          Last piece: a design system, so your website, shop or app looks like {snapshot.name} from day one. Copy the
          values you need, or download them for your tools.
        </p>
        <section className="kit-card kit-document" aria-labelledby="assets-system-title">
          <h2 id="assets-system-title" className={styles.cardTitle}>
            Design system
          </h2>
          <section>
            <h3>Preview</h3>
            <div className="kit-preview" style={{ background: p.background, color: p.text, ...body }}>
              <p className="kit-preview-title" style={{ ...heading, color: p.text }}>
                {slogan ?? snapshot.name}
              </p>
              {positioning && <p>{positioning}</p>}
              <div className="kit-preview-actions">
                <span
                  style={{
                    background: p.primary,
                    color: readableBrandColor(snapshot, p.primary, [p.background]),
                    borderRadius: 999,
                  }}
                >
                  Get started
                </span>
                <span style={{ border: `1px solid ${p.text}`, borderRadius: 999 }}>Learn more</span>
              </div>
              {accentReadable ? (
                <span className="kit-preview-accent" style={{ color: p.accent }}>
                  {snapshot.name}
                </span>
              ) : (
                <span
                  className={styles.previewHighlight}
                  style={{ background: p.accent, color: readableBrandColor(snapshot, p.accent) }}
                >
                  {snapshot.name}
                </span>
              )}
            </div>
          </section>
          <section>
            <h3>Color tokens</h3>
            <div role="table" aria-label="Color tokens" className="kit-tokens">
              {tokens.colors.map((color) => (
                <div role="row" key={color.key}>
                  <span role="cell" className="kit-chip" style={{ background: color.hex }} aria-hidden="true" />
                  <span role="cell">{color.name}</span>
                  <span role="cell">
                    {color.hex} <small>· {color.use}</small>
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3>Type scale</h3>
            <div className="kit-scale">
              {TYPE_SCALE.map((step) => (
                <div key={step.key}>
                  <small>
                    {step.label} · {step.size} / {(step.role === "heading" ? snapshot.heading : snapshot.body).family}{" "}
                    {(step.role === "heading" ? snapshot.heading : snapshot.body).weight}
                  </small>
                  <span
                    style={{
                      ...(step.role === "heading" ? heading : body),
                      fontSize: step.size,
                      lineHeight: step.lineHeight,
                    }}
                  >
                    {step.role === "heading"
                      ? step.key === "display"
                        ? snapshot.name
                        : (slogan ?? snapshot.name)
                      : positioning || snapshot.name}
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="kit-two">
            <div>
              <h3>Spacing</h3>
              <div className="kit-spacing">
                {SPACING.map((value) => (
                  <span key={value}>
                    <i style={{ width: value, height: value }} />
                    {value}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <h3>Corners</h3>
              <div className="kit-corners">
                {CORNERS.map((corner) => (
                  <span key={corner.key}>
                    <i style={{ borderRadius: corner.value }} />
                    {corner.key === "pill" ? corner.label : `${corner.label} · ${corner.value}`}
                  </span>
                ))}
              </div>
            </div>
          </section>
          <section>
            <div className="kit-section-head">
              <h3>Export</h3>
              <div role="group" aria-label="Format" className="naming-filter">
                {(["css", "json"] as const).map((value) => (
                  <button key={value} type="button" aria-pressed={format === value} onClick={() => setFormat(value)}>
                    {value.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <pre className="kit-code" tabIndex={0}>
              {exportText}
            </pre>
            <div className="kit-actions">
              <button
                type="button"
                className="button secondary small"
                onClick={() => void navigator.clipboard?.writeText(exportText).catch(() => {})}
              >
                Copy
              </button>
              <button
                type="button"
                className="button secondary small"
                onClick={() =>
                  saveText(
                    format === "css" ? "design-tokens.css" : "design-tokens.json",
                    format === "css" ? "text/css" : "application/json",
                    exportText,
                  )
                }
              >
                Download {format.toUpperCase()}
              </button>
            </div>
          </section>
        </section>
        <div className="kit-footer">
          <span>
            {pack
              ? `Logo files, images, guidelines and tokens · ZIP · ${pack.files.length} files`
              : "Preparing your files…"}
          </span>
          <button
            type="button"
            className="button primary"
            aria-label="Download brand kit as a ZIP file"
            disabled={disabled}
            onClick={() => downloadFile()}
          >
            Download brand kit
          </button>
        </div>
      </article>
    </div>
  );
}
