"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import styles from "./logo-creation.module.css";

/** Existing saved brief and request controls stay mounted while the panel is closed. */
export function ConceptsComposer({ children, instruction, onInstructionChange, onReview, selectedLabel, selectedPreview, status, onShowResult }: {
  projectId: string; children: ReactNode; instruction: string;
  onInstructionChange(value: string): void; onReview?: () => void;
  selectedLabel?: string; selectedPreview?: ReactNode; status?: string;
  onShowResult?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement;
    if (open) node?.showModal(); else if (node?.open) node.close();
    return () => { if (open && previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  return <>
    <form className={styles.conceptsComposer} aria-label="Logo concept changes" onSubmit={event => { event.preventDefault(); onReview?.(); }}>
      {selectedLabel && <div className={styles.composerSelection}>{selectedPreview}<span>Editing {selectedLabel}</span></div>}
      <textarea aria-label="Describe logo changes" placeholder={selectedLabel ? "Describe what you’d like to change…" : "Select a logo, then describe your changes…"} value={instruction} maxLength={2000} onChange={event => onInstructionChange(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.repeat && (event.metaKey || event.ctrlKey) && onReview) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={1} />
      {status && <p className={styles.composerStatus} role="status">{status}</p>}
      <div className={styles.composerTools}>
        <button type="button" className={styles.contextButton} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-concepts/paperclip.svg" width={16} height={16} alt="" />Project context
        </button>
        {onShowResult && <button type="button" className={styles.secondaryButton} onClick={onShowResult}>View refinement</button>}
        <button type="submit" className={styles.composerSend} aria-label="Review refinement cost" disabled={!onReview} title={onReview ? "Review refinement cost" : status ?? "Select a logo and describe your changes first"}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-concepts/send.svg" width={16} height={16} alt="" />
        </button>
      </div>
    </form>
    <dialog ref={dialog} className={styles.contextDialog} aria-labelledby="logo-context-title" onCancel={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <header className={styles.heading}><h2 id="logo-context-title">Project context</h2><button type="button" className={styles.secondaryButton} aria-label="Close project context" onClick={() => setOpen(false)}><Icon name="close" size={16} /></button></header>
      {children}
    </dialog>
  </>;
}
