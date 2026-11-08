"use client";

import { useState } from "react";

function iconHost(url: string | undefined): string | null {
  if (!url) return null;
  try { const parsed = new URL(url); return parsed.protocol === "https:" ? parsed.hostname : null; } catch { return null; }
}

// Bumped when the server starts choosing icons differently, so browsers do not
// keep showing an earlier, smaller icon from their week-long private cache.
const ICON_VERSION = "3";

/** The competitor's own site icon, fetched through Embel's server. A neutral
 * initial stands in when the site has no usable icon; nothing is invented.
 * Icons and initials share one tile, so every logo has the same size whatever
 * the site provides; an icon fills its tile to the edges. */
export function CompetitorLogo({ projectId, name, url, size = 40 }: { projectId: string; name: string; url?: string; size?: number }) {
  const host = iconHost(url);
  const [failed, setFailed] = useState<string | null>(null);
  const initial = (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  if (!host || failed === host) return <span className="competitor-logo competitor-logo-monogram" style={{ width: size, height: size }} aria-hidden="true">{initial}</span>;
  return <span className="competitor-logo" style={{ width: size, height: size }} aria-hidden="true">
    {/* eslint-disable-next-line @next/next/no-img-element -- a private, same-origin, owner-checked route */}
    <img src={`/api/projects/${projectId}/competitor-icon?host=${encodeURIComponent(host)}&v=${ICON_VERSION}`} alt=""
      width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(host)}
      // An icon that failed before hydration never fires onError; show the initial instead.
      ref={node => { if (node?.complete && node.naturalWidth === 0) setFailed(host); }} />
  </span>;
}
