"use client";

import { useEffect, useRef, useState } from "react";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { IdentityAssetReceipt } from "@/domain/logo-deliverables";
import styles from "./logo-download-controls.module.css";

type Props = {
  client: AccountLogoClient;
  account: VerifiedAccount;
  projectId: string;
  vectorRevisionId?: string | null;
  original?: IdentityAssetReceipt | null;
  disabled?: boolean;
  unsavedChanges?: boolean;
};
const rasterFormats = new Map([["image/png", "PNG"], ["image/jpeg", "JPG"], ["image/webp", "WEBP"]]);
type DownloadState = { scope: string; client: AccountLogoClient; pending: "svg" | "original" | null; message: string; error: boolean };

/** Existing saved files only. No generation, vector acceptance or identity approval is required. */
export function LogoDownloadControls({ client, account, projectId, vectorRevisionId, original, disabled = false, unsavedChanges = false }: Props) {
  const originalFormat = original?.publicationState === "committed" ? rasterFormats.get(original.verification.mimeType) : undefined;
  const scope = `${account.userId}:${account.generation}:${projectId}:${vectorRevisionId ?? ""}:${original?.reference.versionId ?? ""}:${original?.reference.contentHash ?? ""}:${disabled}:${unsavedChanges}`;
  const operation = useRef<AbortController | null>(null);
  const [state, setState] = useState<DownloadState | null>(null);
  const activeState = state?.scope === scope && state.client === client ? state : null;
  const currentClient = isAccountLogoClientCurrent(client, account, projectId);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; }, [scope, client]);

  async function download(kind: "svg" | "original") {
    if (disabled || operation.current || !isAccountLogoClientCurrent(client, account, projectId)
      || kind === "svg" && (!vectorRevisionId || unsavedChanges) || kind === "original" && (!original || !originalFormat)) return;
    const controller = new AbortController(); operation.current = controller;
    const current = () => !controller.signal.aborted && isAccountLogoClientCurrent(client, account, projectId);
    const format = kind === "svg" ? "SVG" : originalFormat!;
    setState({ scope, client, pending: kind, message: "", error: false });
    try {
      const file = kind === "svg" ? await client.downloadLogoVector(vectorRevisionId!, controller.signal) : await client.downloadAsset(original!, controller.signal);
      if (!current()) return;
      if (!file) throw new Error("The saved file is unavailable.");
      const anchor = document.createElement("a");
      anchor.href = file.url;
      anchor.download = `embel-logo.${format.toLowerCase()}`;
      anchor.rel = "noopener noreferrer";
      anchor.referrerPolicy = "no-referrer";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setState({ scope, client, pending: null, message: `${format} download started. Check your browser’s downloads.`, error: false });
    } catch {
      if (current()) setState({ scope, client, pending: null, message: `The ${format} file could not be downloaded. Please try again.`, error: true });
    } finally { if (operation.current === controller) operation.current = null; }
  }

  if (!vectorRevisionId && !originalFormat) return null;
  const blocked = disabled || !currentClient || Boolean(activeState?.pending);
  return <section className={styles.downloads} aria-label="Download your logo">
    <div className={styles.heading}><h2>Download your logo</h2><p>Save your files to your device.</p></div>
    <div className={styles.options}>
      {vectorRevisionId && <div className={styles.option}>
        <button type="button" disabled={blocked || unsavedChanges} onClick={() => void download("svg")}>{activeState?.pending === "svg" ? "Preparing SVG…" : "Download SVG"}</button>
        <p>Saved vector. Stays sharp at any size.</p>
      </div>}
      {originalFormat && <div className={styles.option}>
        <button type="button" disabled={blocked} onClick={() => void download("original")}>{activeState?.pending === "original" ? `Preparing ${originalFormat}…` : `Download ${originalFormat}`}</button>
        <p>{vectorRevisionId ? "Original image, before vector edits." : "Saved original image."}</p>
      </div>}
    </div>
    {vectorRevisionId && unsavedChanges && <p className={styles.notice}>Save or discard your changes before downloading the SVG.</p>}
    {activeState?.message && <p className={styles.notice} role={activeState.error ? "alert" : "status"}>{activeState.message}</p>}
  </section>;
}
