"use client";

import { useEffect, useRef, useState } from "react";
import { createAccountIdentityClient } from "@/components/identity/account-identity-client";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { accountProjectResponseSchema } from "@/domain/project-api";
import { accountRequest, AccountRequestError } from "./account-api";
import { readProjectCardPreview } from "./project-card-preview";
import { nextProjectAction, readProjectVisualState, type ProjectAction } from "./project-continuation";

// A collection may contain fifty cards. Lazy visibility and a shared bound keep
// private metadata/image reads from flooding the account connection pool.
let activeReads = 0;
const waiters = new Set<() => void>();
async function withPreviewSlot(signal: AbortSignal, read: () => Promise<void>) {
  while (activeReads >= 3 && !signal.aborted)
    await new Promise<void>((resolve) => {
      const wake = () => {
        waiters.delete(wake);
        signal.removeEventListener("abort", wake);
        resolve();
      };
      waiters.add(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
  if (signal.aborted) return;
  activeReads++;
  try {
    await read();
  } finally {
    activeReads--;
    [...waiters].forEach((wake) => wake());
  }
}

/** `settled` marks the end of this card's reads, including a failed or timed-out read. */
type PreviewState = {
  identity: string;
  name: string | null;
  selectedName: string | null;
  url: string | null;
  action: ProjectAction | null;
  status: "loading" | "ready" | "unavailable";
  settled: boolean;
};

export function useProjectCardPreview(
  account: VerifiedAccount,
  projectId: string,
  revision: number,
  enabled: boolean,
  artwork = true,
) {
  const { session, isCurrent, expire, viewCache } = useAccountSession();
  const target = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const { userId, generation } = account;
  const identity = `${userId}:${generation}:${projectId}:${revision}`;
  const cacheKey = `card:${artwork ? "artwork" : "plain"}:${projectId}:${revision}`;
  // A card this tab already read for this owner and session shows what it showed, and refreshes quietly (D-073).
  const [state, setState] = useState<PreviewState | null>(() => {
    const kept = enabled ? viewCache?.get<PreviewState>(account, cacheKey) : undefined;
    return kept?.identity === identity ? kept : null;
  });
  const current =
    session.status === "ready" && session.userId === userId && session.generation === generation && isCurrent(account);
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
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [current, enabled]);

  useEffect(() => {
    if (!enabled || !visible || !current) return;
    const captured: VerifiedAccount = { status: "ready", userId, generation };
    const controller = new AbortController();
    const clients = {
      logo: artwork ? createAccountLogoClient(captured, projectId, isCurrent, expire) : null,
      identity: artwork ? createAccountIdentityClient(captured, projectId, isCurrent, expire) : null,
    };
    let active = true;
    const initial: PreviewState = {
      identity,
      name: null,
      selectedName: null,
      action: null,
      url: null,
      status: "loading",
      settled: false,
    };
    const kept = viewCache?.get<PreviewState>(captured, cacheKey);
    // What this read has established so far, starting from what the card already shows.
    let snapshot: PreviewState = kept?.identity === identity ? kept : initial;
    let loadingArtwork = snapshot.status === "loading";
    let preview: { url: string; release(): void } | null = null;
    const live = () => active && !controller.signal.aborted && isCurrent(captured);
    function publish(changes: Partial<PreviewState>) {
      if (!live()) return;
      if (changes.status) loadingArtwork = changes.status === "loading";
      snapshot = { ...snapshot, ...changes };
      setState((previous) => ({ ...(previous?.identity === identity ? previous : initial), ...changes }));
    }
    /** Keep the finished read for a later visit; the kept entry now owns the preview URL. */
    function keep() {
      if (!live() || !viewCache) return;
      if (preview) {
        const owned = preview;
        preview = null;
        viewCache.set(captured, cacheKey, snapshot, () => owned.release());
      } else if (!snapshot.url) viewCache.set(captured, cacheKey, snapshot);
    }
    function handleError(error: unknown) {
      if (error instanceof AccountRequestError && error.status === 401 && live()) expire(captured);
    }
    void withPreviewSlot(controller.signal, async () => {
      const deadline = setTimeout(() => {
        publish(loadingArtwork ? { status: "unavailable", settled: true } : { settled: true });
        controller.abort();
      }, 15_000);
      try {
        const { project } = await accountRequest(`/api/projects/${projectId}`, accountProjectResponseSchema, {
          signal: controller.signal,
          expectedOwnerId: userId,
        });
        if (!live()) return;
        if (project.id !== projectId || project.owner_id !== userId || project.current_revision !== revision)
          throw new AccountRequestError(409);
        publish({ selectedName: project.context.selectedName?.trim() || null });
        const progress = await readProjectVisualState(project, clients.logo, controller.signal);
        if (!live()) return;
        // A broken thumbnail must not hide the next step, and a slow progress
        // check must not prevent the verified logo from being displayed.
        const [action, artworkResult] = await Promise.allSettled([
          nextProjectAction(project, clients, progress, controller.signal).then((action) => publish({ action })),
          (async () => {
            if (!clients.logo || !progress) {
              publish({ status: "ready", url: null });
              return;
            }
            const value = await readProjectCardPreview({
              client: clients.logo,
              ownerId: userId,
              projectId,
              signal: controller.signal,
              progress,
            });
            if (!value || !live()) {
              publish({ status: "unavailable", url: null });
              return;
            }
            preview = value.receipt ? await clients.logo.previewAsset(value.receipt, controller.signal) : null;
            if (!live()) {
              preview?.release();
              preview = null;
              return;
            }
            publish({
              name: value.name,
              url: preview?.url ?? null,
              status: value.receipt && !preview ? "unavailable" : "ready",
            });
          })(),
        ]);
        if (action.status === "rejected") handleError(action.reason);
        if (artworkResult.status === "rejected") {
          handleError(artworkResult.reason);
          publish({ status: "unavailable", url: null });
        }
        publish({ settled: true });
        keep();
      } catch (error) {
        handleError(error);
        publish({ status: "unavailable", settled: true });
        // A card that could not be read shows the same on return, while its next read runs.
        keep();
      } finally {
        clearTimeout(deadline);
      }
    });
    return () => {
      active = false;
      controller.abort();
      preview?.release();
      clients.logo?.dispose();
      clients.identity?.dispose();
    };
  }, [
    artwork,
    cacheKey,
    current,
    enabled,
    expire,
    generation,
    identity,
    isCurrent,
    projectId,
    revision,
    userId,
    viewCache,
    visible,
  ]);

  function rejectImage(url: string) {
    if (viewCache?.get<PreviewState>(account, cacheKey)?.url === url) viewCache.delete(account, cacheKey);
    setState((previous) =>
      previous?.identity === identity && previous.url === url
        ? { ...previous, url: null, status: "unavailable" }
        : previous,
    );
  }
  // Without visibility observation no read starts, so callers show the saved
  // listing instead of waiting for one. Cards only render in the browser.
  const reading = current && enabled && typeof IntersectionObserver !== "undefined";
  return {
    target,
    current,
    reading,
    rejectImage,
    preview: current && enabled && state?.identity === identity ? state : null,
  };
}
