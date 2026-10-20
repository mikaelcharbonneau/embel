"use client";

import { useEffect, useRef, useState } from "react";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { readProjectCardPreview } from "./project-card-preview";

// A collection may contain fifty cards. Lazy visibility and a shared bound keep
// private metadata/image reads from flooding the account connection pool.
let activeReads = 0;
const waiters = new Set<() => void>();
async function withPreviewSlot(signal: AbortSignal, read: () => Promise<void>) {
  while (activeReads >= 3 && !signal.aborted) await new Promise<void>(resolve => {
    const wake = () => { waiters.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
    waiters.add(wake); signal.addEventListener("abort", wake, { once: true });
  });
  if (signal.aborted) return;
  activeReads++;
  try { await read(); }
  finally { activeReads--; [...waiters].forEach(wake => wake()); }
}

type PreviewState = { identity: string; name: string | null; url: string | null; status: "ready" | "unavailable" };

export function useProjectCardPreview(account: VerifiedAccount, projectId: string, revision: number, enabled: boolean) {
  const { session, isCurrent, expire } = useAccountSession();
  const target = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<PreviewState | null>(null);
  const { userId, generation } = account;
  const identity = `${userId}:${generation}:${projectId}:${revision}`;
  const current = session.status === "ready" && session.userId === userId && session.generation === generation && isCurrent(account);
  // Clear during render, before effects release the old URL. A later return to
  // the same account must never resurrect that released private object URL.
  if (state && (!current || !enabled || state.identity !== identity)) setState(null);

  useEffect(() => {
    const element = target.current;
    if (!enabled || !element) return;
    if (typeof IntersectionObserver === "undefined") {
      // Keep the honest placeholder when visibility observation is unavailable;
      // do not eagerly fetch fifty private projects as a fallback.
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [current, enabled]);

  useEffect(() => {
    if (!enabled || !visible || !current) return;
    const captured: VerifiedAccount = { status: "ready", userId, generation };
    const controller = new AbortController();
    const client = createAccountLogoClient(captured, projectId, isCurrent, expire);
    let active = true;
    let preview: { url: string; release(): void } | null = null;
    void withPreviewSlot(controller.signal, async () => {
      const deadline = setTimeout(() => controller.abort(), 15_000);
      try {
        const value = await readProjectCardPreview({ client, ownerId: userId, projectId, signal: controller.signal });
        if (!active || controller.signal.aborted || !isCurrent(captured)) return;
        if (!value) { setState({ identity, name: null, url: null, status: "unavailable" }); return; }
        preview = value.receipt ? await client.previewAsset(value.receipt, controller.signal) : null;
        if (!active || controller.signal.aborted || !isCurrent(captured)) { preview?.release(); preview = null; return; }
        setState({ identity, name: value.name, url: preview?.url ?? null, status: value.receipt && !preview ? "unavailable" : "ready" });
      } catch {
        if (active && !controller.signal.aborted && isCurrent(captured)) setState({ identity, name: null, url: null, status: "unavailable" });
      } finally {
        clearTimeout(deadline);
        if (active && controller.signal.aborted && isCurrent(captured)) setState({ identity, name: null, url: null, status: "unavailable" });
      }
    });
    return () => { active = false; controller.abort(); preview?.release(); client.dispose(); };
  }, [current, enabled, expire, generation, identity, isCurrent, projectId, userId, visible]);

  function rejectImage(url: string) {
    setState(previous => previous?.identity === identity && previous.url === url ? { ...previous, url: null, status: "unavailable" } : previous);
  }
  return { target, current, rejectImage, preview: current && enabled && state?.identity === identity ? state : null };
}
