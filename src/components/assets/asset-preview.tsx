"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MediaFrame, type MediaRatio } from "@/components/ui/media-frame";
import type { AssetVersionDetail } from "@/domain/asset-library";
import { canPreviewAsset, type AccountAssetsClient } from "./account-assets-client";
import { privatePreviewIdentity } from "./private-preview-identity";

/** A Library file's picture in a Media frame: contained, never cropped (IMG-012). Loading is the frame's skeleton;
 * a file with no picture says why in the frame. */
export function AssetPreview({
  version,
  client,
  label,
  retryable = true,
  ratio = "1x1",
  className,
}: {
  version: AssetVersionDetail | null;
  client: AccountAssetsClient;
  label: string;
  retryable?: boolean;
  /** The grid is square; the detail view is 4:3. */
  ratio?: MediaRatio;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{
    client: AccountAssetsClient;
    key: string;
    url?: string;
    release?: () => void;
    failed?: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const verification = version?.fileVerification;
  const key = version
    ? privatePreviewIdentity(version, [
        version.mimeType,
        version.format,
        version.fileState,
        verification?.status,
        verification?.status === "verified"
          ? [verification.contentHash, verification.mimeType, verification.byteLength]
          : null,
      ])
    : null;
  // A later return to this key must not resurrect a blob released on a prior switch.
  if (result && (result.client !== client || result.key !== key)) setResult(null);
  const readVersion = useEffectEvent(() => version);
  useEffect(() => {
    const version = readVersion();
    if (!key || !version || !canPreviewAsset(version)) return;
    const previewVersion = version,
      previewKey = key;
    const controller = new AbortController();
    let release: (() => void) | undefined,
      started = false;
    async function load() {
      if (started || controller.signal.aborted || !client.current()) return;
      started = true;
      try {
        const preview = await client.preview(previewVersion, controller.signal);
        if (!preview) return;
        if (controller.signal.aborted || !client.current()) {
          preview.release();
          return;
        }
        release = preview.release;
        setResult({ client, key: previewKey, url: preview.url, release: preview.release });
      } catch {
        if (!controller.signal.aborted && client.current()) setResult({ client, key: previewKey, failed: true });
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "120px" },
    );
    if (container.current) observer.observe(container.current);
    return () => {
      observer.disconnect();
      controller.abort();
      release?.();
    };
  }, [client, key, attempt]);
  const available = result?.client === client && result.key === key && client.current() ? result : null;
  const failed = available?.failed;
  const unavailable = failed
    ? "Preview unavailable"
    : !version
      ? "No versions yet"
      : version.fileState === "metadata_only"
        ? "Metadata only"
        : version.fileState === "missing_or_invalid"
          ? "File unavailable"
          : !canPreviewAsset(version)
            ? `${version.format.toUpperCase()} file · no preview`
            : null;
  return (
    <div className={className ? `assets-preview ${className}` : "assets-preview"} ref={container}>
      {available?.url ? (
        // Private blob URLs stay in this owner-scoped consumer, without an image proxy.
        <MediaFrame
          ratio={ratio}
          contain
          src={available.url}
          alt={label}
          onImageError={() => {
            available.release?.();
            setResult({ client, key: key!, failed: true });
          }}
        />
      ) : unavailable ? (
        <MediaFrame ratio={ratio} state="failed" failedText={unavailable} />
      ) : (
        <MediaFrame ratio={ratio} state="loading" />
      )}
      {failed && retryable && (
        <Button
          size="sm"
          icon="rotate-ccw"
          onClick={() => {
            setResult(null);
            setAttempt((value) => value + 1);
          }}
        >
          Retry preview
        </Button>
      )}
    </div>
  );
}
