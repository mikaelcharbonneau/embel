"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { IdentityBoardPreview } from "@/domain/project-identity";
import { identityErrorMessage, type AccountIdentityClient } from "./account-identity-client";
import { privatePreviewIdentity } from "../assets/private-preview-identity";

export function IdentitySystemBoard({
  board,
  name,
  client,
  onUrl,
}: {
  board: IdentityBoardPreview;
  name: string;
  client: AccountIdentityClient;
  /** Hears the verified preview's object URL while it is shown (a folded entry draws a small copy of it). */
  onUrl?: (url: string | null) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const key = privatePreviewIdentity(board.asset, [board.asset.mimeType, board.asset.purpose]);
  const readAsset = useEffectEvent(() => board.asset);
  const [preview, setPreview] = useState<{
    client: AccountIdentityClient;
    key: string;
    url?: string;
    release?: () => void;
    loading?: boolean;
    error?: string;
  } | null>(null);
  if (preview && (preview.client !== client || preview.key !== key)) setPreview(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const asset = readAsset();
    const controller = new AbortController();
    let released: (() => void) | undefined,
      started = false;
    async function load() {
      if (started || controller.signal.aborted || !client.current()) return;
      started = true;
      setPreview({ client, key, loading: true });
      try {
        const result = await client.preview(asset, controller.signal);
        if (!result) return;
        if (controller.signal.aborted || !client.current()) {
          result.release();
          return;
        }
        released = result.release;
        setPreview({ client, key, url: result.url, release: result.release });
      } catch (error) {
        if (!controller.signal.aborted && client.current())
          setPreview({ client, key, error: identityErrorMessage(error, "file") });
      }
    }
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                observer?.disconnect();
                void load();
              }
            },
            { rootMargin: "240px" },
          );
    if (observer && node.current) observer.observe(node.current);
    else void load();
    return () => {
      controller.abort();
      observer?.disconnect();
      released?.();
    };
  }, [client, key, retry]);
  const shown = preview?.client === client && preview.key === key && client.current() ? preview : null;
  const shownUrl = shown?.url ?? null;
  const tellUrl = useEffectEvent((url: string | null) => onUrl?.(url));
  // Report the picture when it changes, and also when a listener appears: a board chosen after its picture loaded
  // must still hand that picture to the folded Creative direction entry.
  const listening = Boolean(onUrl);
  useEffect(() => {
    if (listening) tellUrl(shownUrl);
  }, [shownUrl, listening]);
  return (
    <figure className="identity-board">
      <div className="identity-board-image" ref={node}>
        {shown?.url /* Private verified blob; a shared optimizer must not cache it. */ ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shown.url}
            alt={`Saved Identity board for ${name}`}
            decoding="async"
            draggable={false}
            onError={() => {
              shown.release?.();
              if (client.current())
                setPreview({ client, key, error: "The saved file could not be displayed as a raster preview." });
            }}
          />
        ) : (
          <div className="identity-board-state" data-state={shown?.error ? "failed" : "loading"}>
            {/* While the board loads its frame stays empty (a skeleton); words only when something went wrong. */}
            <span className={shown?.error ? undefined : "e-sr"}>{shown?.error ?? "Loading board"}</span>
            {shown?.error && (
              <button className="text-link" type="button" onClick={() => setRetry((value) => value + 1)}>
                Retry preview
              </button>
            )}
          </div>
        )}
      </div>
      {board.staleComponents.length > 0 && (
        <figcaption className="identity-board-stale">This preview is from before your last edit.</figcaption>
      )}
    </figure>
  );
}
