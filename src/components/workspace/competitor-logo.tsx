"use client";

import { useState } from "react";

function iconHost(url: string | undefined): string | null {
  if (!url) return null;
  try { const parsed = new URL(url); return parsed.protocol === "https:" ? parsed.hostname : null; } catch { return null; }
}

/** The competitor's own site icon, fetched through Embel's server. A neutral
 * initial stands in when the site has no usable icon; nothing is invented. */
export function CompetitorLogo({ projectId, name, url, size = 40 }: { projectId: string; name: string; url?: string; size?: number }) {
  const host = iconHost(url);
  const [failed, setFailed] = useState<string | null>(null);
  const initial = (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  if (!host || failed === host) return <span className="competitor-logo competitor-logo-monogram" style={{ width: size, height: size }} aria-hidden="true">{initial}</span>;
  // eslint-disable-next-line @next/next/no-img-element -- a private, same-origin, owner-checked route
  return <img className="competitor-logo" src={`/api/projects/${projectId}/competitor-icon?host=${encodeURIComponent(host)}`} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(host)} />;
}
