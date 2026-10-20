"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AssetDetail, AssetLibraryItem } from "@/domain/asset-library";
import type { LogoExportManifest } from "@/domain/logo-deliverables";
import { describeAssetEvidence } from "@/features/identity-deliverables/model/asset-evidence";
import { Icon } from "@/components/ui/icon";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";
import { AssetPreview } from "./asset-preview";
import { assetErrorMessage, canReadAssetFile, type AccountAssetsClient } from "./account-assets-client";

export function AssetDetailDialog({ item, client, onClose, onSelected, exportManifests = [], exportHref = (_manifestId, projectId) => `/brands/account/${projectId}/logo/deliverables` }: { item: AssetLibraryItem; client: AccountAssetsClient; onClose: () => void; onSelected: () => void; exportManifests?: readonly LogoExportManifest[]; exportHref?: (manifestId: string, projectId: string) => string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [exportEvidence, setExportEvidence] = useState<{ versionId: string; manifest: LogoExportManifest | null } | null>(null);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [choice, setChoice] = useState<string | null>(item.displayedVersion?.versionId ?? null);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileMessage, setFileMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [needsCheck, setNeedsCheck] = useState(false);
  const [reload, setReload] = useState(0);
  const sequence = useRef(0), inFlight = useRef(false), active = useRef(true);
  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    if (!element?.open) element?.showModal();
    element?.querySelector<HTMLElement>("h2")?.focus();
    return () => { active.current = false; element?.close(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(), observed = ++sequence.current;
    void client.detail(item.asset, {}, controller.signal).then(reply => {
      if (reply && !controller.signal.aborted && observed === sequence.current) { setDetail(reply); setError(null); setNeedsCheck(false); setLoading(false); }
    }).catch(cause => { if (!controller.signal.aborted && client.current() && observed === sequence.current) { setError(assetErrorMessage(cause)); setLoading(false); } });
    return () => controller.abort();
  }, [client, item.asset, reload]);
  const version = detail ? detail.versions.items.find(row => row.versionId === choice) ?? (detail.selectedVersion?.versionId === choice ? detail.selectedVersion : null) : null;
  useEffect(() => {
    if (!version || !client.current() || typeof client.exportManifest !== "function") return;
    const controller = new AbortController();
    const publish = (manifest: LogoExportManifest | null) => {
      if (!controller.signal.aborted && client.current()) setExportEvidence({ versionId: version.versionId, manifest });
    };
    void client.exportManifest(version, controller.signal).then(publish).catch(() => publish(null));
    return () => controller.abort();
  }, [client, version]);
  const manifests = exportEvidence?.versionId === version?.versionId && exportEvidence?.manifest ? [...exportManifests, exportEvidence.manifest] : exportManifests;
  const evidence = version ? describeAssetEvidence(version, manifests) : null;
  const isSelected = version?.versionId === detail?.selectedVersion?.versionId;
  const confirmation = detail && version ? `${version.versionId}:${detail.project.current_revision}:${detail.asset.selectionRevision}` : null;
  async function loadMore() {
    if (!detail?.versions.nextCursor || inFlight.current) return;
    inFlight.current = true; setBusy(true); const observed = ++sequence.current;
    try {
      const reply = await client.detail(detail.asset, { cursor: detail.versions.nextCursor });
      if (!reply || !active.current || observed !== sequence.current) return;
      if (reply.asset.selectionRevision !== detail.asset.selectionRevision || reply.project.current_revision !== detail.project.current_revision) { setNeedsCheck(true); setError("This asset or its brand changed. Check the latest version before continuing."); return; }
      const ids = new Set(detail.versions.items.map(row => row.versionId));
      setDetail({ ...reply, versions: { ...reply.versions, items: [...detail.versions.items, ...reply.versions.items.filter(row => !ids.has(row.versionId))] } });
    } catch (cause) { if (active.current && client.current()) setError(assetErrorMessage(cause)); }
    finally { inFlight.current = false; if (active.current && client.current()) setBusy(false); }
  }
  async function select() {
    if (!detail || !version || isSelected || inFlight.current || needsCheck || (version.freshness.status === "stale" && accepted !== confirmation)) return;
    inFlight.current = true; sequence.current += 1; setBusy(true); setError(null);
    try {
      const reply = await client.select(detail.asset, { versionId: version.versionId, expectedSelectionRevision: detail.asset.selectionRevision, expectedProjectRevision: detail.project.current_revision, acceptStaleBasis: accepted === confirmation });
      if (!reply) return;
      onSelected();
      if (active.current) { setDetail(reply); setAccepted(null); }
    } catch (cause) { if (active.current && client.current()) { setError(assetErrorMessage(cause, "write")); setNeedsCheck(true); } }
    finally { inFlight.current = false; if (active.current && client.current()) setBusy(false); }
  }
  async function download() {
    if (!version || inFlight.current) return;
    inFlight.current = true; setBusy(true); setFileMessage(null);
    try {
      const reply = await client.download(version);
      if (!reply || !active.current || !client.current()) return;
      const anchor = document.createElement("a"); anchor.href = reply.url; anchor.rel = "noopener noreferrer"; anchor.referrerPolicy = "no-referrer"; anchor.target = "_blank";
      document.body.append(anchor); anchor.click(); anchor.remove();
      setFileMessage("File checked. Download requested using a private link that expires in 60 seconds.");
    } catch (cause) { if (active.current && client.current()) setFileMessage(assetErrorMessage(cause, "file")); }
    finally { inFlight.current = false; if (active.current && client.current()) setBusy(false); }
  }
  return <dialog ref={dialog} className="assets-detail" aria-labelledby="asset-detail-heading" onCancel={onClose} onClose={onClose} onClick={event => { if (isDialogBackdropClick(event)) onClose(); }}>
    <header><div><span className="assets-eyebrow">{item.project.title}</span><h2 id="asset-detail-heading" tabIndex={-1}>{item.asset.kind}</h2></div><button type="button" className="assets-close" aria-label="Close asset details" onClick={onClose}><Icon name="close" size={19} /></button></header>
    {error && <div className="assets-notice" role="alert"><p>{error}</p><button className="button secondary small" type="button" disabled={busy} onClick={() => { setLoading(true); setAccepted(null); setReload(value => value + 1); }}>Check latest asset</button></div>}
    {loading && <p className="assets-muted" role="status">Loading version history…</p>}
    {detail && <>
      <div className="assets-detail-summary"><Link className="text-link" href={`/brands/account/${detail.project.id}`}>{detail.project.title}<Icon name="arrow" size={13} /></Link><span>{detail.selectedVersion ? `Selected: version ${detail.selectedVersion.versionNumber} · ${detail.selectedVersion.format.toUpperCase()}` : "No selected version"}</span></div>
      <div className="assets-detail-content"><section aria-label="Version preview">
        <AssetPreview key={version?.versionId ?? "empty"} version={version} client={client} label={`${item.asset.kind}, version ${version?.versionNumber ?? ""}`} />
        {version ? <>
          <div className="assets-version-title"><h3>Version {version.versionNumber}</h3><span>{version.format.toUpperCase()}{isSelected ? " · Selected" : ""}</span></div>
          <p className="assets-muted">{version.freshness.status === "stale" ? `Earlier brand context · revision ${version.inputRevision} of ${detail.project.current_revision}` : "Material context has not been verified."}</p>
          <dl className="assets-evidence"><div><dt>File</dt><dd>{version.fileState === "metadata_only" ? "Metadata only — no stored file" : version.fileState === "missing_or_invalid" ? "Missing or invalid file" : version.fileState === "verified" ? "File integrity checked" : "Checked when previewed or downloaded"}</dd></div><div><dt>Origin</dt><dd>{evidence?.origin}</dd></div><div><dt>Rights</dt><dd>{evidence?.rights}</dd></div><div><dt>Vector</dt><dd>{evidence?.vector}</dd></div></dl>
          {evidence?.approvedExportId && exportHref && <Link className="text-link" href={exportHref(evidence.approvedExportId, version.projectId)}>View this brand’s export history</Link>}
          {version.freshness.status === "stale" && !isSelected && <label className="assets-ack"><input type="checkbox" checked={accepted === confirmation} disabled={busy || needsCheck} onChange={event => setAccepted(event.target.checked ? confirmation : null)} /><span>I have reviewed this earlier version against the brand&apos;s current context.</span></label>}
          <div className="assets-detail-actions"><button className="button primary small" type="button" disabled={busy || loading || needsCheck || isSelected || (version.freshness.status === "stale" && accepted !== confirmation)} onClick={() => void select()}>{isSelected ? "Selected version" : version.versionNumber < (detail.versions.items[0]?.versionNumber ?? 0) ? "Restore this version" : "Select this version"}</button><button className="button secondary small" type="button" disabled={busy || !canReadAssetFile(version)} onClick={() => void download()}>Check and download<Icon name="arrow" size={13} /></button></div>
          <p className="assets-muted assets-footnote">Selecting a version updates this asset&apos;s selection. Brand use is recorded separately.</p>
          {fileMessage && <p className="assets-notice" role="status">{fileMessage}</p>}
        </> : <p className="assets-muted">Choose a version from the history.</p>}
      </section><section className="assets-history" aria-labelledby="assets-history-heading"><div><h3 id="assets-history-heading">All versions</h3><span>{detail.versions.items.length} of {detail.versions.totalCount}</span></div>
        <ol>{detail.versions.items.map(row => <li key={row.versionId}><button type="button" aria-pressed={row.versionId === choice} disabled={busy} onClick={() => { setChoice(row.versionId); setAccepted(null); setFileMessage(null); }}><strong>Version {row.versionNumber}<span>{row.format.toUpperCase()}</span></strong><small>{row.versionId === detail.selectedVersion?.versionId ? "Selected" : row.freshness.status === "stale" ? "Earlier context" : "Context unverified"}</small></button></li>)}</ol>
        {!detail.versions.items.length && <p className="assets-muted">No versions have been saved for this asset.</p>}
        {detail.versions.nextCursor && <button className="button secondary small" type="button" disabled={busy || loading || needsCheck} onClick={() => void loadMore()}>Load more versions</button>}
      </section></div>
    </>}
  </dialog>;
}
