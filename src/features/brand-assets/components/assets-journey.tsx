"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { brandBoardFont } from "@/domain/brand-board-fonts";
import { guidedSlogan } from "@/domain/guided-interview";
import { journeyPartLabel } from "@/domain/journey";
import type { ContextSnapshot } from "@/domain/projects";
import { EmbelIdentity } from "@/components/workspace/embel-identity";
import type { BrandAssetFile, PreparedBrandAssets } from "../client/build-pack";
import { BRAND_APPLICATIONS } from "../model/artwork";
import { CORNERS, designTokens, designTokensCss, designTokensJson, SPACING, TYPE_SCALE } from "../model/design-tokens";
import type { BrandAssetSnapshot } from "../model/snapshot";
import { downloadLabel, KitPalette } from "./brand-kit-contents";

type Props = {
  snapshot: BrandAssetSnapshot; pack: PreparedBrandAssets | null; previews: ReadonlyMap<string, string> | undefined;
  downloadFile(file?: BrandAssetFile): void; disabled: boolean; projectId: string; context: ContextSnapshot | null; directionTitle?: string;
};

function saveText(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The chosen fonts are bundled with the app, so previews use the real type. */
function FontFaces({ snapshot }: { snapshot: BrandAssetSnapshot }) {
  const faces = [snapshot.heading, snapshot.body].map(style => brandBoardFont(style.family)).filter((font, index, all) => font && all.findIndex(other => other?.id === font.id) === index);
  return <style>{faces.map(font => `@font-face{font-family:"${font!.family}";src:url("${font!.file}");font-weight:${font!.minWeight} ${font!.maxWeight};font-display:swap;}`).join("")}</style>;
}

/** Assets: Brand images, Brand guidelines and the Design system, each as one of
 * Embel's messages, built only from the saved brand and the chosen direction. */
export function AssetsJourney({ snapshot, pack, previews, downloadFile, disabled, projectId, context, directionTitle }: Props) {
  const files = pack?.files ?? [];
  const tokens = useMemo(() => designTokens(snapshot), [snapshot]);
  const [format, setFormat] = useState<"css" | "json">("css");
  const slogan = context ? guidedSlogan(context) : null;
  const button = (file: BrandAssetFile, label?: string, item?: string) => <button key={file.name} type="button" className="kit-button" disabled={disabled}
    aria-label={label && item ? `Download ${item} ${label}` : undefined} onClick={() => downloadFile(file)}>{label ?? downloadLabel(file)}</button>;
  // The original logo file's bytes are already prepared for the kit; show them directly.
  const logoFile = files.find(file => file.category === "logo" && /^image\/(png|jpeg|webp)$/u.test(file.mimeType));
  const [logoUrl, setLogoUrl] = useState<{ name: string; url: string } | null>(null);
  useEffect(() => {
    if (!logoFile) return;
    const url = URL.createObjectURL(new Blob([logoFile.bytes], { type: logoFile.mimeType }));
    setLogoUrl({ name: logoFile.name, url });
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);
  const logoPreview = logoUrl && logoUrl.name === logoFile?.name ? logoUrl.url : previews?.get(logoFile?.name ?? "");
  const guide = files.find(file => file.category === "guide" && file.mimeType === "text/html");
  const board = files.find(file => file.category === "board");
  const boardPreview = board ? previews?.get(board.name) : undefined;
  const base = `/brands/account/${projectId}`;
  const competitors = context?.competitors.filter(item => item.selected).map(item => item.name) ?? [];
  const audience = context?.audienceSegments.filter(item => item.selected).map(item => item.label) ?? [];
  const heading = { fontFamily: `"${snapshot.heading.family}", system-ui, sans-serif`, fontWeight: snapshot.heading.weight };
  const body = { fontFamily: `"${snapshot.body.family}", system-ui, sans-serif`, fontWeight: snapshot.body.weight };
  const traits = context?.personality ? Object.entries(context.personality).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([key]) => key) : [];
  const exportText = format === "css" ? designTokensCss(tokens) : designTokensJson(tokens);

  return <div className="kit-journey">
    <FontFaces snapshot={snapshot} />

    <article className="guided-assistant-message kit-message" aria-labelledby="assets-images">
      <EmbelIdentity label={journeyPartLabel("assets", "Brand images")} />
      <p className="guided-assistant-copy">{snapshot.name} is coming together. Here are images for your social accounts{directionTitle ? `, all in ${directionTitle}` : ""}. Download any of them, or the whole set.</p>
      {board && <section className="kit-card" aria-label="Brand board">
        <h2>Brand board</h2>
        <figure className="kit-image kit-board">
          <div className="kit-image-frame">{boardPreview /* eslint-disable-line @next/next/no-img-element */ ? <img src={boardPreview} alt={`${snapshot.name} final brand board`} /> : <span role="status">Preparing…</span>}</div>
          <figcaption><span><strong>Your logo, colours and type on one page</strong></span><span className="kit-actions">{button(board, "PNG", "brand board")}</span></figcaption>
        </figure>
      </section>}
      <section className="kit-card">
        <h2 id="assets-images">Social images and templates</h2>
        <p className="kit-hint">Posts and banners also come as editable SVG templates.</p>
        <div className="kit-images">{BRAND_APPLICATIONS.map(spec => {
          const png = files.find(file => file.name === `social/${spec.id}.png`);
          const svg = files.find(file => file.name === `social/${spec.id}.svg`);
          const preview = png && previews?.get(png.name);
          return <figure key={spec.id} className="kit-image" data-wide={spec.width / spec.height > 1.5}>
            <div className="kit-image-frame" style={{ aspectRatio: `${spec.width} / ${spec.height}` }}>
              {preview /* eslint-disable-line @next/next/no-img-element */ ? <img src={preview} alt={`${snapshot.name} ${spec.label.toLowerCase()}`} /> : <span role="status">{pack ? "Not available" : "Preparing…"}</span>}
            </div>
            <figcaption><span><strong>{spec.label}</strong><small>{spec.width} × {spec.height}</small></span>
              <span className="kit-actions">{png && button(png, "PNG", spec.label.toLowerCase())}{svg && button(svg, "SVG", spec.label.toLowerCase())}</span></figcaption>
          </figure>;
        })}</div>
      </section>
      <div className="kit-footer"><span>{BRAND_APPLICATIONS.length} images · Next: Brand guidelines</span><a className="kit-button" href="#assets-guidelines">Continue</a></div>
    </article>

    <article className="guided-assistant-message kit-message" aria-labelledby="assets-guidelines">
      <EmbelIdentity label={journeyPartLabel("assets", "Brand guidelines")} />
      <p className="guided-assistant-copy">Here are your brand guidelines: everything someone needs to use {snapshot.name} consistently. Edit takes you to the step that sets each part.</p>
      <nav className="kit-sections" aria-label="Guideline sections">
        {["Overview", "Logo", "Colours", "Typography", "Voice", "Imagery"].map(name => <a key={name} href={`#g-${name.toLowerCase()}`}>{name}</a>)}
      </nav>
      <section className="kit-card kit-document" aria-label={`${snapshot.name} brand guidelines`}>
        <h2 id="assets-guidelines" className="sr-only">Brand guidelines</h2>
        <section id="g-overview"><div className="kit-section-head"><h3>Overview</h3><Link href={`${base}?view=strategy`}>Edit</Link></div>
          <p className="kit-brand-name" style={heading}>{snapshot.name}</p>
          {slogan && <p className="kit-slogan" style={body}>{slogan}</p>}
          <dl>
            {context?.positioning && <div><dt>Positioning</dt><dd>{context.positioning}</dd></div>}
            {audience.length > 0 && <div><dt>Audience</dt><dd>{audience.join(" · ")}</dd></div>}
            {competitors.length > 0 && <div><dt>Compared with</dt><dd>{competitors.join(", ")}</dd></div>}
          </dl>
        </section>
        <section id="g-logo"><div className="kit-section-head"><h3>Logo</h3><Link href={`${base}/logo`}>Edit</Link></div>
          {/* eslint-disable @next/next/no-img-element -- previews are the prepared files' local object URLs */}
          <div className="kit-logo-pair">
            <div style={{ background: snapshot.palette.background }}>{logoPreview ? <img src={logoPreview} alt={`${snapshot.name} logo on a light background`} /> : <span>Logo</span>}</div>
            <div style={{ background: snapshot.palette.primary }}>{logoPreview ? <img src={logoPreview} alt={`${snapshot.name} logo on the primary colour`} /> : <span>Logo</span>}</div>
          </div>
          {/* eslint-enable @next/next/no-img-element */}
          <p>Use the logo on light backgrounds with clear space around it. Keep it clear of other text and images, and never stretch or recolour it.</p>
          <div className="kit-actions">{files.filter(file => file.category === "logo").map(file => button(file))}</div>
        </section>
        <section id="g-colours"><div className="kit-section-head"><h3>Colours</h3><Link href={`${base}/logo/directions`}>Edit</Link></div>
          <KitPalette colors={snapshot.colors} />
          {snapshot.colorNotes && <p>{snapshot.colorNotes}</p>}
        </section>
        <section id="g-typography"><div className="kit-section-head"><h3>Typography</h3><Link href={`${base}/logo/directions`}>Edit</Link></div>
          <div className="kit-type-pair">
            {[["Headings", snapshot.heading, heading], ["Body", snapshot.body, body]].map(([role, style, css]) => {
              const font = brandBoardFont((style as BrandAssetSnapshot["heading"]).family);
              return <div key={role as string}><div className="kit-section-head"><span>{role as string} · {(style as BrandAssetSnapshot["heading"]).family} {(style as BrandAssetSnapshot["heading"]).weight}</span>
                {font && <a href={font.url} target="_blank" rel="noopener noreferrer">Font link ↗</a>}</div>
                <p style={css as React.CSSProperties}>{role === "Headings" ? (slogan ?? snapshot.name) : context?.positioning || `${snapshot.name}, set in its body type.`}</p></div>;
            })}
          </div>
          {snapshot.typeNotes && <p>{snapshot.typeNotes}</p>}
        </section>
        <section id="g-voice"><div className="kit-section-head"><h3>Voice</h3><Link href={`${base}?view=strategy`}>Edit</Link></div>
          {traits.length ? <p>Leads with {traits.join(" and ")}{slogan ? `, as in “${slogan}”` : ""}.</p> : <p>Set the personality in Voice to describe how {snapshot.name} sounds.</p>}
        </section>
        <section id="g-imagery"><div className="kit-section-head"><h3>Imagery</h3><Link href={`${base}/logo/directions`}>Edit</Link></div>
          {snapshot.graphicNotes && <p>{snapshot.graphicNotes}</p>}
          {snapshot.compositionNotes && <p>{snapshot.compositionNotes}</p>}
        </section>
      </section>
      <div className="kit-footer"><span>Next: Design system</span>{guide && button(guide, "Download guidelines")}<a className="kit-button" href="#assets-system">Continue</a></div>
    </article>

    <article className="guided-assistant-message kit-message" aria-labelledby="assets-system">
      <EmbelIdentity label={journeyPartLabel("assets", "Design system")} />
      <p className="guided-assistant-copy">Last piece: a design system, so your website, shop or app looks like {snapshot.name} from day one. Copy the values you need, or download them for your tools.</p>
      <section className="kit-card kit-document" aria-label={`${snapshot.name} design system`}>
        <h2 id="assets-system" className="sr-only">Design system</h2>
        <section><h3>Preview</h3>
          <div className="kit-preview" style={{ background: snapshot.palette.background, color: snapshot.palette.text, ...body }}>
            <p className="kit-preview-title" style={{ ...heading, color: snapshot.palette.text }}>{slogan ?? snapshot.name}</p>
            {context?.positioning && <p>{context.positioning}</p>}
            <div className="kit-preview-actions">
              <span style={{ background: snapshot.palette.primary, color: snapshot.palette.background, borderRadius: 999 }}>Get started</span>
              <span style={{ border: `1px solid ${snapshot.palette.text}`, borderRadius: 999 }}>Learn more</span>
            </div>
            <span className="kit-preview-accent" style={{ color: snapshot.palette.accent }}>{snapshot.name}</span>
          </div>
        </section>
        <section><h3>Colour tokens</h3>
          <div role="table" aria-label="Colour tokens" className="kit-tokens">{tokens.colors.map(color => <div role="row" key={color.key}>
            <span role="cell" className="kit-chip" style={{ background: color.hex }} aria-hidden="true" />
            <span role="cell">{color.name}</span><span role="cell">{color.hex} <small>· {color.use}</small></span>
          </div>)}</div>
        </section>
        <section><h3>Type scale</h3>
          <div className="kit-scale">{TYPE_SCALE.map(step => <div key={step.key}>
            <small>{step.label} · {step.size} / {(step.role === "heading" ? snapshot.heading : snapshot.body).family} {(step.role === "heading" ? snapshot.heading : snapshot.body).weight}</small>
            <span style={{ ...(step.role === "heading" ? heading : body), fontSize: step.size, lineHeight: step.lineHeight }}>{step.role === "heading" ? (step.key === "display" ? snapshot.name : slogan ?? snapshot.name) : context?.positioning || snapshot.name}</span>
          </div>)}</div>
        </section>
        <section className="kit-two"><div><h3>Spacing</h3><div className="kit-spacing">{SPACING.map(value => <span key={value}><i style={{ width: value, height: value }} />{value}</span>)}</div></div>
          <div><h3>Corners</h3><div className="kit-corners">{CORNERS.map(corner => <span key={corner.key}><i style={{ borderRadius: corner.value }} />{corner.key === "pill" ? corner.label : `${corner.label} · ${corner.value}`}</span>)}</div></div></section>
        <section><div className="kit-section-head"><h3>Export</h3>
          <div role="group" aria-label="Format" className="naming-filter">{(["css", "json"] as const).map(value => <button key={value} type="button" aria-pressed={format === value} onClick={() => setFormat(value)}>{value.toUpperCase()}</button>)}</div></div>
          <pre className="kit-code" tabIndex={0}>{exportText}</pre>
          <div className="kit-actions">
            <button type="button" className="kit-button" onClick={() => void navigator.clipboard?.writeText(exportText).catch(() => {})}>Copy</button>
            <button type="button" className="kit-button" onClick={() => saveText(format === "css" ? "design-tokens.css" : "design-tokens.json", format === "css" ? "text/css" : "application/json", exportText)}>Download {format.toUpperCase()}</button>
          </div>
        </section>
      </section>
      <div className="kit-footer"><span>{pack ? `Logo files, images, guidelines and tokens · ZIP · ${pack.files.length} files` : "Preparing your files…"}</span>
        <button type="button" className="kit-button kit-primary" disabled={disabled} onClick={() => downloadFile()}>Download brand kit</button></div>
    </article>
  </div>;
}
