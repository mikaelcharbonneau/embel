"use client";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "@/components/ui/icon";
import styles from "./logo-creation.module.css";

/** Existing saved brief and request controls stay mounted while the panel is closed. */
export function ConceptsComposer({ children, instruction, onInstructionChange, onGenerate, generationAction, selectedLabel, selectedPreview, status, onShowResult, selectionReadState, disclosureRef }: {
  projectId: string; children: ReactNode; instruction: string;
  onInstructionChange(value: string): void; onGenerate?: () => void;
  generationAction?: ReactNode;
  selectedLabel?: string; selectedPreview?: ReactNode; status?: string;
  onShowResult?: () => void;
  /** Presentation only; callback presence remains the availability for deliberate generation. */
  selectionReadState?: "loading" | "unavailable";
  disclosureRef?: RefObject<HTMLButtonElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const fieldsId = useId();
  const readMessage = selectionReadState === "loading" ? "Loading saved logo details…" : selectionReadState === "unavailable" ? "Saved logo details unavailable." : null;
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement;
    if (open) node?.showModal(); else if (node?.open) node.close();
    return () => { if (open && previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  return <>
    <form className={styles.conceptsComposer} aria-label="Logo concept changes" aria-busy={selectionReadState === "loading"} onSubmit={event => { event.preventDefault(); onGenerate?.(); }}>
      <div className={styles.composerHeader}>
        <div className={styles.composerSelection}>{selectedPreview && <span className={styles.composerThumbnail}><Icon name="brands" size={18} />{selectedPreview}</span>}<span>{selectedLabel ? `Refinement target: ${selectedLabel}` : readMessage ?? "Select a project logo to refine"}</span></div>
        <div className={styles.composerHeaderActions}>
          <button ref={disclosureRef} type="button" className={styles.secondaryButton} aria-expanded={expanded} aria-controls={fieldsId} disabled={!expanded && !selectedLabel} onClick={() => setExpanded(value => !value)}>{expanded ? "Close refinement" : "Refine logo"}</button>
          {onShowResult && <button type="button" className={styles.secondaryButton} onClick={onShowResult}>View refinement</button>}
          <button type="button" className={styles.contextButton} aria-haspopup="dialog" onClick={() => setOpen(true)}>Project context</button>
        </div>
      </div>
      {status && <p className={styles.composerStatus} role="status">{status}</p>}
      <div id={fieldsId} hidden={!expanded}>
      <textarea aria-label="Describe logo changes" placeholder={readMessage ?? (selectedLabel ? "Describe what you’d like to change…" : "Select a logo, then describe your changes…")} value={instruction} maxLength={2000} onChange={event => onInstructionChange(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.repeat && (event.metaKey || event.ctrlKey) && onGenerate) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={1} />
      <div className={styles.composerTools}>
        {generationAction ?? <button type="submit" className={styles.composerSend} aria-label={onGenerate ? "Generate refinement" : readMessage ?? "Generate refinement"} disabled={!onGenerate} title={onGenerate ? "Generate refinement" : readMessage ?? status ?? "Select a logo and describe your changes first"}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-concepts/send.svg" width={16} height={16} alt="" />
        </button>}
      </div>
      </div>
    </form>
    <dialog ref={dialog} className={styles.contextDialog} aria-labelledby="logo-context-title" onCancel={() => setOpen(false)} onClick={event => { if (isDialogBackdropClick(event)) setOpen(false); }}>
      <header className={styles.heading}><h2 id="logo-context-title">Project context</h2><button type="button" className={styles.secondaryButton} aria-label="Close project context" onClick={() => setOpen(false)}><Icon name="close" size={16} /></button></header>
      {children}
    </dialog>
  </>;
}
