"use client";

import { useState } from "react";

function iconHost(url: string | undefined): string | null {
  if (!url) return null;
  try { const parsed = new URL(url); return parsed.protocol === "https:" ? parsed.hostname : null; } catch { return null; }
}

// Bumped when the server starts choosing icons differently, so browsers do not
// keep showing an earlier, smaller icon from their week-long private cache.
const ICON_VERSION = "2";

/** The competitor's own site icon, fetched through Embel's server. A neutral
 * initial stands in when the site has no usable icon; nothing is invented. */
export function CompetitorLogo({ projectId, name, url, size = 40 }: { projectId: string; name: string; url?: string; size?: number }) {
  const host = iconHost(url);
  const [failed, setFailed] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ host: string; width: number } | null>(null);
  const initial = (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  if (!host || failed === host) return <span className="competitor-logo competitor-logo-monogram" style={{ width: size, height: size }} aria-hidden="true">{initial}</span>;
  // A site that only offers a tiny icon shows it smaller instead of stretched and blurred.
  const width = natural?.host === host ? natural.width : 0;
  const shown = width && size >= 32 && width < size * 1.6 ? Math.max(16, Math.min(size, Math.round(width * 0.625))) : size;
  const measure = (image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth && natural?.host !== host) setNatural({ host, width: image.naturalWidth });
  };
  // eslint-disable-next-line @next/next/no-img-element -- a private, same-origin, owner-checked route
  return <img ref={measure} className="competitor-logo" src={`/api/projects/${projectId}/competitor-icon?host=${encodeURIComponent(host)}&v=${ICON_VERSION}`} alt=""
    width={size} height={size} loading="lazy" decoding="async" style={shown < size ? { padding: (size - shown) / 2 } : undefined}
    onLoad={event => setNatural({ host, width: event.currentTarget.naturalWidth })} onError={() => setFailed(host)} />;
}
