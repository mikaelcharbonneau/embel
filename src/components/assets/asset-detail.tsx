"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AssetDetail, AssetLibraryItem } from "@/domain/asset-library";
import type { LogoExportManifest } from "@/domain/logo-deliverables";
import { describeAssetEvidence } from "@/features/identity-deliverables/model/asset-evidence";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { Menu } from "@/components/ui/menu";
import { InlineMessage } from "@/components/ui/message";
import { assetStep, assetTitle } from "./asset-labels";
import { AssetPreview } from "./asset-preview";
import { assetErrorMessage, canReadAssetFile, type AccountAssetsClient } from "./account-assets-client";

/** "Nov 12, 2026". */
function longDate(iso: string) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })
    : null;
}

/**
 * One Library file (D-035, D-034): its picture whole, whether it is in the brand, where it was made, its versions
 * and its file. Like and Save are toggles; Download checks the file before handing over a private link. Built on
 * the system's Dialog, which stays open through development's double effects and returns focus to the opener.
 */
export function AssetDetailDialog({
  item,
  name,
  client,
  onClose,
  onSelected,
  retention,
  exportManifests = [],
  exportHref = (_manifestId, projectId) => `/brands/account/${projectId}/logo/deliverables`,
}: {
  item: AssetLibraryItem;
  /** The name its card showed ("Logo concept 3"). */
  name?: string;
  client: AccountAssetsClient;
  onClose: () => void;
  onSelected: () => void;
  /** Like and Save, run by the list so its cards and tabs stay in step. */
  retention?: { busy: boolean; onToggle: (field: "liked" | "saved") => void };
  exportManifests?: readonly LogoExportManifest[];
  exportHref?: (manifestId: string, projectId: string) => string;
}) {
  const [exportEvidence, setExportEvidence] = useState<{
    versionId: string;
    manifest: LogoExportManifest | null;
  } | null>(null);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [choice, setChoice] = useState<string | null>(item.displayedVersion?.versionId ?? null);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileMessage, setFileMessage] = useState<{ tone: "positive" | "danger"; text: string } | null>(null);
  const [running, setRunning] = useState<"more" | "select" | "download" | null>(null);
  const busy = running !== null;
  const [loading, setLoading] = useState(true);
  const [needsCheck, setNeedsCheck] = useState(false);
  const [reload, setReload] = useState(0);
  const sequence = useRef(0),
    inFlight = useRef(false),
    active = useRef(true);
  const title = name ?? assetTitle(item.asset?.kind);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController(),
      observed = ++sequence.current;
    void client
      .detail(item.asset, {}, controller.signal)
      .then((reply) => {
        if (reply && !controller.signal.aborted && observed === sequence.current) {
          setDetail(reply);
          setError(null);
          setNeedsCheck(false);
          setLoading(false);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted && client.current() && observed === sequence.current) {
          setError(assetErrorMessage(cause));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [client, item.asset, reload]);
  const version = detail
    ? (detail.versions.items.find((row) => row.versionId === choice) ??
      (detail.selectedVersion?.versionId === choice ? detail.selectedVersion : null))
    : null;
  useEffect(() => {
    if (!version || !client.current() || typeof client.exportManifest !== "function") return;
    const controller = new AbortController();
    const publish = (manifest: LogoExportManifest | null) => {
      if (!controller.signal.aborted && client.current()) setExportEvidence({ versionId: version.versionId, manifest });
    };
    void client
      .exportManifest(version, controller.signal)
      .then(publish)
      .catch(() => publish(null));
    return () => controller.abort();
  }, [client, version]);
  const manifests =
    exportEvidence?.versionId === version?.versionId && exportEvidence?.manifest
      ? [...exportManifests, exportEvidence.manifest]
      : exportManifests;
  const evidence = version ? describeAssetEvidence(version, manifests) : null;
  const isSelected = version?.versionId === detail?.selectedVersion?.versionId;
  const latest = detail?.versions.items[0]?.versionNumber ?? 0;
  const confirmation =
    detail && version
      ? `${version.versionId}:${detail.project.current_revision}:${detail.asset.selectionRevision}`
      : null;
  const chosen = Boolean(item.asset?.usage && (item.asset.usage.active || item.asset.usage.legacy));
  const step = assetStep(item.asset?.kind);
  const made = longDate(version?.createdAt ?? item.asset?.createdAt ?? "");

  async function loadMore() {
    if (!detail?.versions.nextCursor || inFlight.current) return;
    inFlight.current = true;
    setRunning("more");
    const observed = ++sequence.current;
    try {
      const reply = await client.detail(detail.asset, { cursor: detail.versions.nextCursor });
      if (!reply || !active.current || observed !== sequence.current) return;
      if (
        reply.asset.selectionRevision !== detail.asset.selectionRevision ||
        reply.project.current_revision !== detail.project.current_revision
      ) {
        setNeedsCheck(true);
        setError("This file or its brand changed. Check the latest version before continuing.");
        return;
      }
      const ids = new Set(detail.versions.items.map((row) => row.versionId));
      setDetail({
        ...reply,
        versions: {
          ...reply.versions,
          items: [...detail.versions.items, ...reply.versions.items.filter((row) => !ids.has(row.versionId))],
        },
      });
    } catch (cause) {
      if (active.current && client.current()) setError(assetErrorMessage(cause));
    } finally {
      inFlight.current = false;
      if (active.current && client.current()) setRunning(null);
    }
  }
  async function select() {
    if (
      !detail ||
      !version ||
      isSelected ||
      inFlight.current ||
      needsCheck ||
      (version.freshness.status === "stale" && accepted !== confirmation)
    )
      return;
    inFlight.current = true;
    sequence.current += 1;
    setRunning("select");
    setError(null);
    try {
      const reply = await client.select(detail.asset, {
        versionId: version.versionId,
        expectedSelectionRevision: detail.asset.selectionRevision,
        expectedProjectRevision: detail.project.current_revision,
        acceptStaleBasis: accepted === confirmation,
      });
      if (!reply) return;
      onSelected();
      if (active.current) {
        setDetail(reply);
        setAccepted(null);
      }
    } catch (cause) {
      if (active.current && client.current()) {
        setError(assetErrorMessage(cause, "write"));
        setNeedsCheck(true);
      }
    } finally {
      inFlight.current = false;
      if (active.current && client.current()) setRunning(null);
    }
  }
  async function download() {
    if (!version || inFlight.current) return;
    inFlight.current = true;
    setRunning("download");
    setFileMessage(null);
    try {
      const reply = await client.download(version);
      if (!reply || !active.current || !client.current()) return;
      const anchor = document.createElement("a");
      anchor.href = reply.url;
      anchor.rel = "noopener noreferrer";
      anchor.referrerPolicy = "no-referrer";
      anchor.target = "_blank";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setFileMessage({
        tone: "positive",
        text: "File checked. Your download uses a private link that expires in 60 seconds.",
      });
    } catch (cause) {
      if (active.current && client.current())
        setFileMessage({ tone: "danger", text: assetErrorMessage(cause, "file") });
    } finally {
      inFlight.current = false;
      if (active.current && client.current()) setRunning(null);
    }
  }

  const versionLabel = (row: { versionNumber: number; format: string }) =>
    `Version ${row.versionNumber}${row.versionNumber === latest ? " · Latest" : ""}`;
  const fileState =
    version?.fileState === "metadata_only"
      ? "Metadata only — no stored file"
      : version?.fileState === "missing_or_invalid"
        ? "Missing or invalid file"
        : null;

  return (
    <Dialog
      size="lg"
      media
      className="assets-detail"
      title={title}
      closeLabel="Close asset details"
      onClose={onClose}
      footer={
        <>
          {retention && (
            <>
              <IconButton
                icon="heart"
                variant="outlined"
                label={`Like ${title}`}
                pressed={item.asset.liked}
                disabled={retention.busy}
                onClick={() => retention.onToggle("liked")}
              />
              <IconButton
                icon="library"
                variant="outlined"
                label={`Save ${title} to your library`}
                pressed={item.asset.saved}
                disabled={retention.busy}
                onClick={() => retention.onToggle("saved")}
              />
            </>
          )}
          <Button
            variant="primary"
            icon="download"
            loading={running === "download"}
            disabled={busy || !version || !canReadAssetFile(version)}
            onClick={() => void download()}
          >
            Download {version ? version.format.toUpperCase() : "file"}
          </Button>
        </>
      }
    >
      <div className="assets-detail__layout">
        <AssetPreview
          key={version?.versionId ?? "empty"}
          version={version ?? (loading ? item.displayedVersion : null)}
          client={client}
          ratio="4x3"
          className="assets-detail__media"
          label={`${title}${version ? `, version ${version.versionNumber}` : ""}`}
        />
        <div className="e-stack e-stack--lg assets-detail__facts">
          {chosen && (
            <div>
              <Badge icon="check">Chosen</Badge>
            </div>
          )}
          <dl className="assets-evidence">
            <div>
              <dt>Brand</dt>
              <dd>
                <Link className="e-link" href={`/brands/account/${item.project.id}`}>
                  {item.project.title}
                </Link>
              </dd>
            </div>
            {step && (
              <div>
                <dt>Step</dt>
                <dd>{step}</dd>
              </div>
            )}
            {made && (
              <div>
                <dt>Made</dt>
                <dd>{made}</dd>
              </div>
            )}
            {version && (
              <div>
                <dt>File</dt>
                <dd>{fileState ? `${version.format.toUpperCase()} · ${fileState}` : version.format.toUpperCase()}</dd>
              </div>
            )}
            {/* Origin, rights and vector rows describe an approved logo export; other images have nothing to state. */}
            {evidence?.approvedExportId && (
              <>
                <div>
                  <dt>Origin</dt>
                  <dd>{evidence.origin}</dd>
                </div>
                <div>
                  <dt>Rights</dt>
                  <dd>{evidence.rights}</dd>
                </div>
                <div>
                  <dt>Vector</dt>
                  <dd>{evidence.vector}</dd>
                </div>
              </>
            )}
          </dl>
          {loading && (
            <p className="e-muted" role="status">
              Loading versions…
            </p>
          )}
          {detail && (
            <div className="e-stack e-stack--sm assets-versions">
              <p className="e-field__label">Version</p>
              {version ? (
                <Menu
                  align="start"
                  label="Versions"
                  items={[
                    ...detail.versions.items.map((row) => ({
                      kind: "choice" as const,
                      label: `${versionLabel(row)} · ${row.format.toUpperCase()}${
                        row.versionId === detail.selectedVersion?.versionId ? " · Selected" : ""
                      }`,
                      checked: row.versionId === choice,
                      onSelect: () => {
                        setChoice(row.versionId);
                        setAccepted(null);
                        setFileMessage(null);
                      },
                    })),
                    ...(detail.versions.nextCursor
                      ? [
                          { kind: "separator" as const },
                          {
                            kind: "action" as const,
                            label: "Load more versions",
                            disabled: busy || loading || needsCheck,
                            onSelect: () => void loadMore(),
                          },
                        ]
                      : []),
                  ]}
                  trigger={(props) => (
                    <Button {...props} className="assets-version-title" disabled={busy}>
                      {versionLabel(version)}
                      <Icon name="chevron-down" size="sm" />
                    </Button>
                  )}
                />
              ) : (
                <p className="e-muted">
                  {detail.versions.items.length ? "Choose a version." : "No versions have been saved for this file."}
                </p>
              )}
              <p className="e-muted">
                {detail.selectedVersion
                  ? `Version ${detail.selectedVersion.versionNumber} is the selected version of this file.`
                  : "No version of this file is selected yet."}{" "}
                {detail.versions.items.length} of {detail.versions.totalCount}{" "}
                {detail.versions.totalCount === 1 ? "version" : "versions"} shown.
              </p>
              {version && !isSelected && (
                <>
                  {version.freshness.status === "stale" && (
                    <label className="e-check assets-ack">
                      <input
                        className="e-box"
                        type="checkbox"
                        checked={accepted === confirmation}
                        disabled={busy || needsCheck}
                        onChange={(event) => setAccepted(event.target.checked ? confirmation : null)}
                      />
                      <span className="e-check__text">
                        This version was made from earlier brand details (revision {version.inputRevision} of{" "}
                        {detail.project.current_revision}). I have checked it against the current ones.
                      </span>
                    </label>
                  )}
                  <div>
                    <Button
                      loading={running === "select"}
                      disabled={
                        busy ||
                        loading ||
                        needsCheck ||
                        (version.freshness.status === "stale" && accepted !== confirmation)
                      }
                      onClick={() => void select()}
                    >
                      {version.versionNumber < latest ? "Restore this version" : "Select this version"}
                    </Button>
                  </div>
                </>
              )}
              {evidence?.approvedExportId && exportHref && (
                <Link
                  className="e-link e-link--standalone"
                  href={exportHref(evidence.approvedExportId, version!.projectId)}
                >
                  View this brand’s export history
                  <Icon name="arrow-right" size="sm" />
                </Link>
              )}
            </div>
          )}
          {error && (
            <InlineMessage
              tone="danger"
              actions={
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setLoading(true);
                    setAccepted(null);
                    setReload((value) => value + 1);
                  }}
                >
                  Check latest asset
                </Button>
              }
            >
              {error}
            </InlineMessage>
          )}
          {fileMessage && <InlineMessage tone={fileMessage.tone}>{fileMessage.text}</InlineMessage>}
        </div>
      </div>
    </Dialog>
  );
}
