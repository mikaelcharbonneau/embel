"use client";

import { useRef, useState, type ReactNode } from "react";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { referenceElements, type IdentityReferenceEntry } from "@/domain/identity-references";
import { ReferencePreview } from "@/components/identity/reference-preview";
import { createReferenceIntentMemory, useIdentityReferences } from "@/components/identity/use-identity-references";
import { useReferenceUpload } from "@/components/identity/use-reference-upload";
import { LOGO_LIKED_UPLOAD_LIMIT } from "@/domain/logo-saved-inputs";
import { Heart } from "./inspiration-brands";

const ACCEPTED = "image/png,image/jpeg,image/webp";
// Recorded as the reference's permission note: who added it and that nothing was verified.
export const INSPIRATION_UPLOAD_NOTE = "Added by the account owner from Inspiration as a private reference. No license was checked.";
/** A readable title from the file name, since nothing is typed by hand. */
export function referenceTitle(fileName: string) {
  const title = fileName.replace(/\.[^.]+$/u, "").replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
  return (title || "Your image").slice(0, 240);
}
const userSupplied = (entry: IdentityReferenceEntry) => entry.reference.source === "user_supplied";

export type YourReferences = { action: ReactNode; status: ReactNode; liked: number; revision: number | null; section: (likedOnly: boolean) => ReactNode };

/** "Add your own references" in the Inspiration gallery: the button opens the
 * system file picker, every chosen image is saved one after another with no
 * form, and the images appear in a "Your images" container with a heart each. */
export function useYourReferences(account: VerifiedAccount, projectId: string): YourReferences {
  const [memory] = useState(() => { const value = createReferenceIntentMemory(); value.bind(account.userId); return value; });
  const reference = useIdentityReferences(account, projectId, memory);
  const unavailable = !reference.project || reference.project.scope === "naming_only" || reference.blocked;
  const upload = useReferenceUpload({ account, projectId, blocked: unavailable, onSaved: reference.refresh });
  const picker = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  async function add(files: File[]) {
    if (!files.length) return;
    setProgress({ done: 0, total: files.length });
    for (const [index, file] of files.entries()) {
      const saved = await upload.upload(file, { label: referenceTitle(file.name), creator: null, sourceUrl: null, rightsNote: INSPIRATION_UPLOAD_NOTE, relevantElements: [...referenceElements], tags: [] });
      if (!saved) {
        setProgress(null);
        if (index + 1 < files.length) upload.setNotice(previous => `${previous ?? "An image could not be added."} ${files.length - index - 1} more ${files.length - index - 1 === 1 ? "image was" : "images were"} not added; add ${files.length - index - 1 === 1 ? "it" : "them"} again once this is resolved.`);
        return;
      }
      setProgress({ done: index + 1, total: files.length });
    }
    setProgress(null);
    upload.setNotice(files.length === 1 ? "Image added. Like it to use it as inspiration." : `${files.length} images added. Like the ones to use as inspiration.`);
  }
  const items = reference.page?.references.items.filter(userSupplied) ?? [];
  const liked = items.filter(entry => entry.reaction.ensemble).length;
  // The logo and Creative direction can each use three liked images (plus the
  // logo itself); every selected reference counts, including ones chosen elsewhere.
  const selected = reference.page?.selectedReferenceCount ?? reference.filterMetadata?.selectedReferenceCount ?? liked;
  const atLimit = selected >= LOGO_LIKED_UPLOAD_LIMIT;
  const busy = upload.busy || Boolean(progress);
  const action = <>
    <button type="button" className="inspiration-footer-link" disabled={busy || unavailable || Boolean(upload.retained)} onClick={() => picker.current?.click()}>Add your own references</button>
    <input ref={picker} type="file" accept={ACCEPTED} multiple hidden aria-label="Choose images to add" onChange={event => { const files = [...event.target.files ?? []]; event.target.value = ""; void add(files); }} />
  </>;
  const { retained, retry } = upload;
  const status = progress ? <p className="inspiration-yours-status" role="status">Adding {progress.total === 1 ? "your image" : `image ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`}…</p>
    : retained ? <div className="inspiration-yours-status inspiration-recovery" role="status"><p>{upload.notice ?? `“${retained.input.metadata.attribution.label}” is still being added. Keep this page open so the original file is kept.`}</p><div>
      <button type="button" disabled={upload.busy} onClick={() => void upload.check()}>Check upload</button>
      <button type="button" disabled={upload.busy} onClick={() => void upload.cancel()}>Cancel upload</button>
      {retry === "rejected" && <button type="button" disabled={upload.busy} onClick={upload.discardRejected}>Discard upload</button>}
      {retry && retry !== "rejected" && <button type="button" disabled={upload.busy || unavailable} onClick={() => void upload.retryOriginal()}>{retry === "registration" ? "Finish adding it" : "Retry upload"}</button>}
    </div></div>
      : upload.notice ? <p className="inspiration-yours-status" role="status">{upload.notice}</p> : null;
  const section = (likedOnly: boolean) => {
    const shown = likedOnly ? items.filter(entry => entry.reaction.ensemble) : items;
    if (!shown.length) return null;
    return <article className="inspiration-brand inspiration-yours" aria-label="Your images">
      <header className="inspiration-brand-header"><span className="inspiration-brand-title"><strong>Your images</strong><span className="inspiration-yours-count">{shown.length === 1 ? "1 image" : `${shown.length} images`}</span></span></header>
      <div className="inspiration-yours-grid">{shown.map(entry => {
        const { reaction, reference: image } = entry, pending = reference.pending.has(image.id), intent = reference.intents.has(image.id);
        return <div key={image.id} className="inspiration-yours-tile">
          <ReferencePreview media={image.media} label={image.attribution.label} client={reference.client} />
          <button type="button" className="inspiration-heart inspiration-part-like" aria-pressed={reaction.ensemble} aria-label={`${reaction.ensemble ? "Unlike" : "Like"} ${image.attribution.label}`}
            disabled={pending || intent || (atLimit && !reaction.ensemble)} onClick={() => { if (!upload.retained) upload.setNotice(null); void reference.react(entry, { ensemble: !reaction.ensemble, elements: reaction.elements }); }}><Heart liked={reaction.ensemble} /></button>
        </div>;
      })}</div>
      {atLimit && !likedOnly && <p className="inspiration-yours-limit">You’ve liked three of your own images, the most Embel can use. Unlike one to choose another.</p>}
      {reference.error && <p className="inspiration-yours-status" role="alert">{reference.error}</p>}
    </article>;
  };
  return { action, status, liked, revision: reference.page?.referenceRevision ?? reference.filterMetadata?.referenceRevision ?? null, section };
}
