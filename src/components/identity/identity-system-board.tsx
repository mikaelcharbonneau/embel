"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  IdentityBoardPreview,
  IdentityFreshness,
  IdentityProductionFile,
  IdentitySystemSource,
} from "@/domain/project-identity";
import { identityErrorMessage, type AccountIdentityClient } from "./account-identity-client";
import { privatePreviewIdentity } from "../assets/private-preview-identity";

export function identitySourceLabel(source: IdentitySystemSource): string {
  return source.kind === "generated"
    ? "Generated system"
    : source.component === "colors"
      ? "Manual colors edit"
      : "Manual typography edit";
}
const componentLabels = {
  logo: "logo",
  colors: "colors",
  typography: "typography",
  graphics: "graphics",
  imagery: "imagery",
  composition: "composition",
};
export function IdentityFreshnessNotice({ freshness }: { freshness: IdentityFreshness }) {
  if (freshness.status === "current") return <p className="identity-freshness">Matches the saved brand inputs</p>;
  if (freshness.status === "unavailable")
    return (
      <p className="identity-freshness identity-freshness-stale">
        {freshness.reason === "missing_name"
          ? "Add a saved brand name to compare this system with current inputs."
          : "The saved brand names disagree. Correct them before choosing or editing a system."}
      </p>
    );
  return (
    <p className="identity-freshness identity-freshness-stale">
      Earlier inputs: {freshness.changed.map((key) => (key === "strategy" ? "Strategy" : key)).join(", ")}
    </p>
  );
}
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
  useEffect(() => {
    tellUrl(shownUrl);
  }, [shownUrl]);
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
          <div className="identity-board-state">
            <span>{shown?.loading ? "Checking private preview…" : (shown?.error ?? "Private board preview")}</span>
            {shown?.error && (
              <button className="text-link" type="button" onClick={() => setRetry((value) => value + 1)}>
                Retry preview
              </button>
            )}
          </div>
        )}
      </div>
      {board.staleComponents.length > 0 && (
        <figcaption className="identity-board-stale">
          Preview predates this edit: {board.staleComponents.map((component) => componentLabels[component]).join(", ")}.
          The saved component specifications below contain the changes.
        </figcaption>
      )}
    </figure>
  );
}
function IdentityFile({ file, client }: { file: IdentityProductionFile; client: AccountIdentityClient }) {
  const [state, setState] = useState<{
    client: AccountIdentityClient;
    pending: boolean;
    message: string | null;
  } | null>(null);
  const pending = state?.client === client && state.pending;
  async function download() {
    if (!client.current() || pending) return;
    setState({ client, pending: true, message: null });
    try {
      const reply = await client.download(file.asset);
      if (!reply || !client.current()) return;
      const anchor = document.createElement("a");
      anchor.href = reply.url;
      anchor.rel = "noopener noreferrer";
      anchor.referrerPolicy = "no-referrer";
      anchor.download = "";
      anchor.click();
      setState({ client, pending: false, message: "A checked download link was opened." });
    } catch (error) {
      if (client.current()) setState({ client, pending: false, message: identityErrorMessage(error, "file") });
    }
  }
  return (
    <li>
      <div>
        <strong>{file.role}</strong>
        <span>
          {componentLabels[file.component]} · {file.asset.mimeType}
        </span>
      </div>
      <button
        type="button"
        className="text-link"
        disabled={pending}
        onClick={() => {
          void download();
        }}
      >
        {pending ? "Checking file…" : "Check and download"}
      </button>
      {state?.client === client && state.message && <p role="status">{state.message}</p>}
    </li>
  );
}
export function IdentityProductionFiles({
  files,
  client,
}: {
  files: IdentityProductionFile[];
  client: AccountIdentityClient;
}) {
  return (
    <section className="identity-files" aria-label="Production files">
      <h4>Production files</h4>
      {files.length ? (
        <>
          <p>Saved file roles and formats. Each download checks the private original.</p>
          <ul>
            {files.map((file) => (
              <IdentityFile
                key={`${file.component}:${file.role}:${file.asset.versionId}`}
                file={file}
                client={client}
              />
            ))}
          </ul>
        </>
      ) : (
        <p>No separate production files are attached to this system.</p>
      )}
    </section>
  );
}
