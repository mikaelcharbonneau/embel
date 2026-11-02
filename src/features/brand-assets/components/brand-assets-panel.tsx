"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { IdentityLogoSource } from "@/domain/identity-logo-source";
import type { AccountIdentityClient } from "@/components/identity/account-identity-client";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { BrandAssetError, brandAssetSlug, createBrandAssetSnapshot, type BrandAssetSnapshot, type BrandAssetSystem } from "../model/snapshot";
import { boundedBrandAssetWork } from "../client/browser-assets";
import { buildBrandAssetPack, type PreparedBrandAssets, type BrandAssetFile } from "../client/build-pack";
import styles from "./brand-assets.module.css";

export type BrandAssetsPanelProps = {
  system: BrandAssetSystem;
  sourceLogo: IdentityLogoSource;
  identityClient: AccountIdentityClient;
  logoClient: AccountLogoClient;
  account: VerifiedAccount;
  projectId: string;
  /** Freshly confirm this system is selected and its frozen source logo is still current. */
  revalidate(signal: AbortSignal): Promise<boolean>;
  vectorRevisionId?: string | null;
};
function errorMessage(error: unknown): string {
  if (error instanceof BrandAssetError) {
    if (error.reason === "selection") return "Your selected logo or direction has changed. Reload this page to create its matching assets.";
    if (error.reason === "unsupported") return "This older direction does not contain the design details needed for a complete asset pack. Choose a newly generated direction.";
    if (error.reason === "font") return "The chosen fonts could not be loaded for these assets. Retry, or choose another direction if the problem continues.";
    if (error.reason === "font_coverage") return "This saved direction uses fonts that cannot render all of its text. Choose or generate a new direction with compatible fonts.";
    if (error.reason === "unsupported_text") return "Some characters in this brand's text cannot yet be rendered in downloadable assets. Remove unsupported symbols or use a supported spelling before generating a new direction.";
    if (error.reason === "timeout") return "Creating the assets took too long. Check your connection and try again.";
    if (error.reason === "canvas") return "This browser could not prepare the images. Please retry in a current browser.";
    if (error.reason === "size") return "These source files are too large to package in this browser.";
  }
  return "The saved logo or direction could not be checked. Reload the page and try again.";
}
export function BrandAssetsPanel(props: BrandAssetsPanelProps) {
  const result = useMemo(() => {
    try { return { snapshot: createBrandAssetSnapshot({ system: props.system, sourceLogo: props.sourceLogo, ownerId: props.account.userId, projectId: props.projectId }), error: null }; }
    catch (error) { return { snapshot: null, error: errorMessage(error) }; }
  }, [props.system, props.sourceLogo, props.account.userId, props.projectId]);
  if (!result.snapshot) return <p role="alert">{result.error}</p>;
  return <OwnedBrandAssets key={`${props.account.generation}:${JSON.stringify(result.snapshot)}:${props.vectorRevisionId ?? ""}`} {...props} snapshot={result.snapshot} />;
}
type Ready = { pack: PreparedBrandAssets; previews: Map<string, string>; logoClient: AccountLogoClient; identityClient: AccountIdentityClient };
function OwnedBrandAssets({ snapshot, logoClient, identityClient, account, projectId, revalidate, vectorRevisionId }: BrandAssetsPanelProps & { snapshot: BrandAssetSnapshot }) {
  const [ready, setReady] = useState<Ready | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null), urls = useRef(new Map<string, ReturnType<typeof setTimeout> | null>());
  const current = () => identityClient.current() && isAccountLogoClientCurrent(logoClient, account, projectId);
  const shown = ready?.logoClient === logoClient && ready.identityClient === identityClient && current() ? ready : null;
  useEffect(() => {
    const activeUrls = urls.current;
    return () => {
      operation.current?.abort(); operation.current = null;
      for (const [url, timer] of activeUrls) { if (timer) clearTimeout(timer); URL.revokeObjectURL(url); } activeUrls.clear();
    };
  }, [logoClient, identityClient]);
  function clearPrepared() {
    for (const [url, timer] of urls.current) { if (timer) clearTimeout(timer); URL.revokeObjectURL(url); } urls.current.clear(); setReady(null);
  }
  async function confirm(signal: AbortSignal) {
    if (!current() || signal.aborted || !await revalidate(signal) || !current() || signal.aborted) throw new BrandAssetError("selection");
  }
  async function create() {
    if (operation.current || !current()) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError(null); setMessage(null);
    try {
      const pack = await boundedBrandAssetWork(controller.signal, async signal => {
        await confirm(signal);
        const value = await buildBrandAssetPack({ snapshot, logoClient, identityClient, vectorRevisionId }, signal);
        await confirm(signal); return value;
      });
      if (!current() || controller.signal.aborted) return;
      clearPrepared(); const previews = new Map<string, string>();
      for (const file of pack.files.filter(file => file.mimeType === "image/png" && ["board", "social"].includes(file.category))) {
        const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType })); urls.current.set(url, null); previews.set(file.name, url);
      }
      setReady({ pack, previews, logoClient, identityClient }); setMessage("Your brand assets are ready.");
    } catch (error) { if (current() && !controller.signal.aborted) { clearPrepared(); setError(errorMessage(error)); } }
    finally { if (operation.current === controller) { operation.current = null; if (current() && !controller.signal.aborted) setBusy(false); } }
  }
  async function download(file?: BrandAssetFile) {
    if (!shown || operation.current || !current()) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError(null); setMessage(null);
    let selectionChecked = false;
    try {
      await boundedBrandAssetWork(controller.signal, confirm);
      if (!current() || controller.signal.aborted) return;
      selectionChecked = true;
      const url = URL.createObjectURL(new Blob([file?.bytes ?? shown.pack.archive], { type: file?.mimeType ?? "application/zip" }));
      urls.current.set(url, setTimeout(() => { urls.current.delete(url); URL.revokeObjectURL(url); }, 1000));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = file ? file.name.split("/").at(-1)! : `${brandAssetSlug(snapshot.name)}-brand-assets.zip`;
      document.body.append(anchor); try { anchor.click(); } finally { anchor.remove(); }
      setMessage("Download started. Check your browser’s downloads.");
    } catch (error) {
      if (current() && !controller.signal.aborted) {
        if (error instanceof BrandAssetError && error.reason === "selection") { clearPrepared(); setError(errorMessage(error)); }
        else setError(selectionChecked
          ? "The download could not start. Your files are kept. Try downloading again."
          : "Your saved choice could not be checked. Your files are kept. Try downloading again.");
      }
    }
    finally { if (operation.current === controller) { operation.current = null; if (current() && !controller.signal.aborted) setBusy(false); } }
  }
  const disabled = busy || !current();
  const fileButton = (file: BrandAssetFile) => <button key={file.name} type="button" disabled={disabled} onClick={() => void download(file)}>{file.editable ? "Editable SVG" : file.mimeType === "image/png" ? "Download PNG" : file.mimeType === "image/svg+xml" ? "Download SVG" : file.mimeType === "text/html" ? "Download guide" : file.mimeType === "image/jpeg" ? "Download JPG" : file.mimeType === "image/webp" ? "Download WEBP" : "Download"}</button>;
  return <section className={styles.panel} aria-label="Brand assets">
    <header className={styles.header}><div><h2>{shown ? "Your brand assets" : "Create your brand assets"}</h2><p>{shown ? "Your selected identity, ready to use." : "Your logo, colors, fonts, social images and editable templates. No additional AI cost."}</p></div>
      {shown ? <button className={styles.primary} type="button" disabled={disabled} onClick={() => void download()}>{busy ? "Checking selection…" : "Download everything"}</button>
        : <button className={styles.primary} type="button" disabled={disabled} onClick={() => void create()}>{busy ? "Creating your assets…" : "Create brand assets"}</button>}
    </header>
    {error && <p className={styles.error} role="alert">{error}</p>}{message && <p className={styles.notice} role="status">{message}</p>}
    {shown && <>
      <div className={styles.overview}><div className={styles.board}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Local output rendered from verified owned artwork. */}
        <img src={shown.previews.get("brand-board.png")} alt={`${snapshot.name} final brand board`} />
        {fileButton(shown.pack.files.find(file => file.category === "board")!)}
      </div><div className={styles.details}><h3>Logo files</h3><p>Original saved artwork{shown.pack.vectorIncluded ? " and its matching SVG vector." : "."}</p><div className={styles.actions}>{shown.pack.files.filter(file => file.category === "logo").map(fileButton)}</div>
        <h3>Colors and fonts</h3><div className={styles.swatches}>{snapshot.colors.map(color => <span key={color.key} title={`${color.name} ${color.hex}`} style={{ background: color.hex }} />)}</div><p>{[...new Set(snapshot.typography.map(style => style.family))].join(" · ")}</p>{fileButton(shown.pack.files.find(file => file.mimeType === "text/html")!)}
        <p className={styles.help}>The guide includes color values and links to install your fonts.</p><h3>Editable templates</h3><p>SVG templates have editable text, colors and shapes. Their logo remains the original image.</p><p className={styles.help}>Replace the placeholder copy before publishing.</p>
      </div></div>
      <div className={styles.gallery}>{shown.pack.files.filter(file => file.category === "social" && file.mimeType === "image/png").map(file => <article className={styles.card} key={file.name}>
        <div className={styles.artwork}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Verified local output only. */}
          <img src={shown.previews.get(file.name)} alt={`${snapshot.name} ${file.label.toLowerCase()}`} />
        </div>
        <div className={styles.cardBody}><h3>{file.label}</h3><p>{file.width} × {file.height}</p><div className={styles.actions}>{fileButton(file)}{shown.pack.files.filter(other => other.name === file.name.replace(/\.png$/, ".svg")).map(fileButton)}</div></div>
      </article>)}</div>
    </>}
  </section>;
}
