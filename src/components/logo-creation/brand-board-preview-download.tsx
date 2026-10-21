"use client";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { InspirationChoice } from "@/domain/inspiration";
import type { IdentityAssetReceipt } from "@/domain/logo-deliverables";
import type { LogoType } from "@/domain/logo-workspace";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { BOARD_PREVIEW_WIDTH, BOARD_PREVIEW_HEIGHT, boardPreviewError, boardPreviewFilename, boundedBoardPreview, createBoardPreviewSnapshot, prepareBoardPreview, recheckBoardPreviewLogo, type BoardPreviewSnapshot } from "./brand-board-preview-export";
import styles from "./logo-creation.module.css";
import downloadStyles from "./brand-board-preview-download.module.css";

type Props = { client: AccountLogoClient; account: VerifiedAccount; projectId: string; name: string; logoType: LogoType; choices: readonly InspirationChoice[]; receipt: IdentityAssetReceipt; logoNeedsReview: boolean };
export function BrandBoardPreviewDownload(props: Props) {
  const snapshot = createBoardPreviewSnapshot(props);
  // Every meaningful display/receipt change remounts the export lifetime. JSON is
  // only an internal comparison key; it is never a filename or artifact content.
  return <SnapshotDownload key={JSON.stringify(snapshot)} client={props.client} account={props.account} projectId={props.projectId} snapshot={snapshot} />;
}
function SnapshotDownload({ client, account, projectId, snapshot }: Pick<Props, "client" | "account" | "projectId"> & { snapshot: BoardPreviewSnapshot }) {
  const { isCurrent } = useAccountSession(), description = useId();
  const [state, setState] = useState<{ client: AccountLogoClient; blob: Blob | null; imageUrl: string | null; error: string | null; busy: boolean; started: boolean }>({ client, blob: null, imageUrl: null, error: null, busy: true, started: false });
  const [retry, setRetry] = useState(0), locked = useRef(false), lifetime = useRef<AbortController | null>(null), urls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const current = () => isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
  const readSnapshot = useEffectEvent(() => snapshot);
  const stillCurrent = useEffectEvent(current);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller; locked.current = false;
    const activeUrls = urls.current;
    let imageUrl: string | null = null;
    void boundedBoardPreview(controller.signal, signal => prepareBoardPreview(client, readSnapshot(), signal)).then(blob => {
      if (!controller.signal.aborted && stillCurrent()) { imageUrl = URL.createObjectURL(blob); setState({ client, blob, imageUrl, error: null, busy: false, started: false }); }
    }).catch(error => {
      if (!controller.signal.aborted && stillCurrent()) setState({ client, blob: null, imageUrl: null, error: boardPreviewError(error), busy: false, started: false });
    });
    return () => {
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      for (const [url, timer] of activeUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
      activeUrls.clear();
    };
  }, [client, retry]);
  async function download() {
    const controller = lifetime.current, blob = state.blob;
    if (!controller || controller.signal.aborted || !blob || state.client !== client || locked.current || !current()) return;
    locked.current = true; setState(value => ({ ...value, busy: true, error: null, started: false }));
    try {
      await boundedBoardPreview(controller.signal, signal => recheckBoardPreviewLogo(client, snapshot, signal));
      if (controller.signal.aborted || !current()) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      // The delayed revocation lets browsers consume the download; cleanup on an
      // account/selection change revokes it immediately. No URL is persisted.
      urls.current.set(url, setTimeout(() => { urls.current.delete(url); URL.revokeObjectURL(url); }, 1000));
      anchor.href = url; anchor.download = boardPreviewFilename(snapshot);
      document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); }
      setState(value => ({ ...value, busy: false, started: true }));
    } catch (error) {
      if (!controller.signal.aborted && current()) { if (state.imageUrl) URL.revokeObjectURL(state.imageUrl); setState({ client, blob: null, imageUrl: null, error: boardPreviewError(error), busy: false, started: false }); }
    } finally { if (lifetime.current === controller) locked.current = false; }
  }
  return <div className={downloadStyles.action}>
    <figure className={downloadStyles.board} data-brand-board-layout aria-label="Complete raster Brand Board">
      <div className={downloadStyles.boardImage}>
      {state.imageUrl && state.client === client && current() ? <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.imageUrl} width={BOARD_PREVIEW_WIDTH} height={BOARD_PREVIEW_HEIGHT} alt={`${snapshot.name} Brand Board: selected logo, proposed palette, typography, social post and X header in one image.`} />
      </> : <p role="status">{state.error ? "Brand Board preview unavailable. Your saved inputs are kept." : "Composing your Brand Board…"}</p>}
      </div><figcaption>One raster image · Social post and X header included · {snapshot.logoNeedsReview ? "Review changed logo inputs" : "Saved logo selection"}</figcaption>
    </figure>
    <button type="button" className={styles.secondaryButton} disabled={state.client !== client || !state.blob || state.busy || !current()} aria-describedby={description} onClick={() => void download()}>{state.busy ? state.blob ? "Checking preview…" : "Preparing preview…" : "Download board preview (PNG)"}</button>
    <p id={description}>One PNG with your selected logo, proposed palette, typography, social post and X banner. Placeholder social copy; not vector masters or an approved brand package.</p>
    {state.error && <p role="alert">{state.error} <button type="button" className={styles.secondaryButton} onClick={() => { if (!current()) return; setState({ client, blob: null, imageUrl: null, error: null, busy: true, started: false }); setRetry(value => value + 1); }}>Retry preview</button></p>}
    {state.started && <p role="status">Preview download started. Check your browser’s downloads.</p>}
  </div>;
}
