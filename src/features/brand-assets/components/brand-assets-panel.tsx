"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IdentityLogoSource } from "@/domain/identity-logo-source";
import type { AccountIdentityClient } from "@/components/identity/account-identity-client";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import {
  BrandAssetError,
  brandAssetSlug,
  createBrandAssetSnapshot,
  type BrandAssetSnapshot,
  type BrandAssetSystem,
} from "../model/snapshot";
import { boundedBrandAssetWork } from "../client/browser-assets";
import { buildBrandAssetPack, type PreparedBrandAssets, type BrandAssetFile } from "../client/build-pack";
import { AssetsJourney } from "./assets-journey";
import { guidedSlogan } from "@/domain/guided-interview";
import type { ContextSnapshot } from "@/domain/projects";
import { Button } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/message";
import { useToast } from "@/components/ui/toast";

export type BrandAssetsPanelProps = {
  system: BrandAssetSystem;
  sourceLogo: IdentityLogoSource;
  identityClient: AccountIdentityClient;
  logoClient: AccountLogoClient;
  account: VerifiedAccount;
  projectId: string;
  /** Freshly confirm this system is selected and its frozen source logo is still current. */
  revalidate(signal: AbortSignal): Promise<boolean>;
  vectorRevisionId?: string | null;
  directionTitle?: string;
  onRefreshSelection?(): void;
  /** The saved project (positioning, audience, personality and the optional slogan). */
  context?: ContextSnapshot | null;
};
function errorMessage(error: unknown): string {
  if (error instanceof BrandAssetError) {
    if (error.reason === "selection")
      return "Your selected logo or direction has changed. Refresh the kit to see the current files.";
    if (error.reason === "unsupported")
      return "This older direction does not contain the design details needed for a complete asset pack. Choose a newly generated direction.";
    if (error.reason === "font")
      return "The chosen fonts could not be loaded. Check your connection and try downloading the kit again.";
    if (error.reason === "font_coverage")
      return "This saved direction uses fonts that cannot render all of its text. Choose or generate a new direction with compatible fonts.";
    if (error.reason === "unsupported_text")
      return "Some characters in this brand’s text cannot yet be rendered in downloadable assets. Remove unsupported symbols or use a supported spelling before generating a new direction.";
    if (error.reason === "timeout") return "Preparing the kit took too long. Check your connection and try again.";
    if (error.reason === "canvas")
      return "This browser could not prepare the images. Please retry in a current browser.";
    if (error.reason === "size") return "These source files are too large to package in this browser.";
  }
  return "The saved artwork could not be loaded. Check your connection and try downloading the kit again.";
}
export function BrandAssetsPanel(props: BrandAssetsPanelProps) {
  const result = useMemo(() => {
    try {
      return {
        snapshot: createBrandAssetSnapshot({
          system: props.system,
          sourceLogo: props.sourceLogo,
          ownerId: props.account.userId,
          projectId: props.projectId,
        }),
        error: null,
      };
    } catch (error) {
      return { snapshot: null, error: errorMessage(error) };
    }
  }, [props.system, props.sourceLogo, props.account.userId, props.projectId]);
  if (!result.snapshot)
    return (
      <section aria-label="Brand assets">
        <h1 className="e-sr">Assets</h1>
        <InlineMessage tone="danger">{result.error}</InlineMessage>
      </section>
    );
  return (
    <OwnedBrandAssets
      key={`${props.account.generation}:${JSON.stringify(result.snapshot)}:${props.vectorRevisionId ?? ""}`}
      {...props}
      snapshot={result.snapshot}
    />
  );
}
type Ready = {
  pack: PreparedBrandAssets;
  previews: Map<string, string>;
  logoClient: AccountLogoClient;
  identityClient: AccountIdentityClient;
};
type DownloadSession = Pick<Ready, "logoClient" | "identityClient"> & {
  download(file?: BrandAssetFile): Promise<void>;
  /** Prepares the kit again from the saved sources. */
  retry(): void;
};

function OwnedBrandAssets({
  snapshot,
  logoClient,
  identityClient,
  account,
  projectId,
  revalidate,
  vectorRevisionId,
  directionTitle,
  onRefreshSelection,
  context = null,
}: BrandAssetsPanelProps & { snapshot: BrandAssetSnapshot }) {
  const toast = useToast();
  const slogan = context ? guidedSlogan(context) : null,
    positioning = context?.positioning || null;
  // Saved words the guidelines quote: the selected audience and the two leading personality traits.
  const audience = useMemo(
    () => context?.audienceSegments.filter((item) => item.selected).map((item) => item.label) ?? [],
    [context],
  );
  const traits = useMemo(
    () =>
      context?.personality
        ? Object.entries(context.personality)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(([key]) => key)
        : [],
    [context],
  );
  const [ready, setReady] = useState<Ready | null>(null);
  const [downloading, setDownloading] = useState(false),
    [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const session = useRef<DownloadSession | null>(null);

  // Install the download handler before the enabled button can receive a click.
  useLayoutEffect(() => {
    const lifetime = new AbortController();
    const urls = new Map<string, ReturnType<typeof setTimeout> | null>();
    let prepared: Promise<Ready> | null = null;
    let downloadingFile = false,
      selectionChanged = false;
    const current = () =>
      !lifetime.signal.aborted &&
      identityClient.current() &&
      isAccountLogoClientCurrent(logoClient, account, projectId);
    function releaseUrls() {
      for (const [url, timer] of urls) {
        if (timer) clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      urls.clear();
    }
    function discardSelection() {
      selectionChanged = true;
      prepared = null;
      releaseUrls();
      setReady(null);
      setStale(true);
    }
    async function confirm(signal: AbortSignal) {
      if (!current() || signal.aborted || !(await revalidate(signal)) || !current() || signal.aborted)
        throw new BrandAssetError("selection");
    }
    // Opening the page and clicking Download both consume this same preparation.
    // The saved direction is the durable source, including in a fresh browser.
    function prepare(): Promise<Ready> {
      if (prepared) return prepared;
      setError(null);
      prepared = boundedBrandAssetWork(lifetime.signal, async (signal) => {
        await confirm(signal);
        const pack = await buildBrandAssetPack(
          {
            snapshot,
            logoClient,
            identityClient,
            vectorRevisionId,
            slogan,
            positioning,
            direction: directionTitle ?? null,
            audience,
            traits,
          },
          signal,
        );
        await confirm(signal);
        return pack;
      })
        .then((pack) => {
          if (!current()) throw new BrandAssetError("selection");
          const previews = new Map<string, string>();
          for (const file of pack.files) {
            if (file.mimeType !== "image/png" || !["board", "social"].includes(file.category)) continue;
            const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType }));
            urls.set(url, null);
            previews.set(file.name, url);
          }
          const value = { pack, previews, logoClient, identityClient };
          setReady(value);
          setMessage("Ready to download.");
          return value;
        })
        .catch((cause) => {
          if (current()) {
            prepared = null;
            if (cause instanceof BrandAssetError && cause.reason === "selection") discardSelection();
            else {
              releaseUrls();
              setReady(null);
            }
            setError(errorMessage(cause));
          }
          throw cause;
        });
      return prepared;
    }
    async function download(file?: BrandAssetFile) {
      if (!current() || downloadingFile || selectionChanged) return;
      downloadingFile = true;
      setDownloading(true);
      setError(null);
      setMessage(null);
      let built = false,
        checked = false;
      try {
        const { pack } = await prepare();
        if (!current()) return;
        built = true;
        await boundedBrandAssetWork(lifetime.signal, confirm);
        if (!current()) return;
        if (file && !pack.files.includes(file)) throw new BrandAssetError("selection");
        checked = true;
        const url = URL.createObjectURL(
          new Blob([file?.bytes ?? pack.getArchive()], { type: file?.mimeType ?? "application/zip" }),
        );
        urls.set(
          url,
          setTimeout(() => {
            urls.delete(url);
            URL.revokeObjectURL(url);
          }, 1000),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file ? file.name.split("/").at(-1)! : `${brandAssetSlug(snapshot.name)}-brand-assets.zip`;
        document.body.append(anchor);
        try {
          anchor.click();
        } finally {
          anchor.remove();
        }
        setMessage("Ready to download.");
        toast(file ? `${file.label} downloaded` : "Brand kit downloaded");
      } catch (cause) {
        // Preparation already reported its own failure. A transient download
        // failure leaves the verified previews available for another click.
        if (current() && built) {
          if (cause instanceof BrandAssetError) {
            if (cause.reason === "selection") discardSelection();
            setError(errorMessage(cause));
          } else
            setError(
              checked
                ? "The download could not start. Your files are kept. Try downloading again."
                : "Your saved choice could not be checked. Your files are kept. Try downloading again.",
            );
        }
      } finally {
        downloadingFile = false;
        if (current()) setDownloading(false);
      }
    }
    function retry() {
      if (!current() || downloadingFile || selectionChanged) return;
      prepared = null;
      releaseUrls();
      setReady(null);
      setMessage(null);
      void prepare().catch(() => {
        /* The panel displays the error; the next click retries. */
      });
    }
    session.current = { logoClient, identityClient, download, retry };
    // A discarded Strict Mode mount must not start a second private asset read.
    queueMicrotask(() => {
      if (!current()) return;
      setStale(false);
      setDownloading(downloadingFile);
      setMessage(null);
      setReady(null);
      void prepare().catch(() => {
        /* The panel displays the error; the next click retries. */
      });
    });
    return () => {
      lifetime.abort();
      session.current = null;
      releaseUrls();
    };
  }, [
    snapshot,
    logoClient,
    identityClient,
    account,
    projectId,
    revalidate,
    vectorRevisionId,
    slogan,
    positioning,
    directionTitle,
    audience,
    traits,
    toast,
  ]);

  if (!identityClient.current() || !isAccountLogoClientCurrent(logoClient, account, projectId)) return null;
  const shown = ready?.logoClient === logoClient && ready.identityClient === identityClient ? ready : null;
  function downloadFile(file?: BrandAssetFile) {
    const active = session.current;
    if (active?.logoClient === logoClient && active.identityClient === identityClient) void active.download(file);
  }
  function retry() {
    const active = session.current;
    if (active?.logoClient === logoClient && active.identityClient === identityClient) active.retry();
  }
  // Announced politely beside the kit's Download button.
  const status = downloading
    ? "Preparing your download…"
    : message || (!error && !shown ? "Preparing your files…" : "");
  const notice = error ? (
    <InlineMessage
      tone="danger"
      actions={
        stale ? (
          onRefreshSelection && (
            <Button size="sm" icon="refresh-cw" onClick={onRefreshSelection}>
              Refresh kit
            </Button>
          )
        ) : (
          <Button size="sm" icon="rotate-ccw" disabled={downloading} onClick={retry}>
            Try again
          </Button>
        )
      }
    >
      {error}
    </InlineMessage>
  ) : null;
  return (
    <section aria-label="Brand assets">
      {stale ? (
        <div className="e-stack e-stack--lg">
          <h1 className="e-sr">Assets</h1>
          {notice}
          {!error && onRefreshSelection && (
            <div>
              <Button icon="refresh-cw" onClick={onRefreshSelection}>
                Refresh kit
              </Button>
            </div>
          )}
        </div>
      ) : (
        <AssetsJourney
          notice={notice}
          preparing={!shown && !error}
          onRetry={retry}
          snapshot={snapshot}
          pack={shown?.pack ?? null}
          previews={shown?.previews}
          downloadFile={downloadFile}
          disabled={downloading}
          projectId={projectId}
          context={context}
          directionTitle={directionTitle}
          status={status}
        />
      )}
    </section>
  );
}
