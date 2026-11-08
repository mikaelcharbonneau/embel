"use client";

import type { ReactNode, RefObject } from "react";
import { Icon } from "@/components/ui/icon";
import styles from "./logo-creation.module.css";

/** One refine area for the chosen logo. A typed change survives the first set
 * of concepts arriving. */
export function ConceptsComposer({ instruction, onInstructionChange, onGenerate, generationAction, selectedLabel, selectedPreview, selectedActions, status, onShowResult, selectionReadState, inputRef, idle = false, footer }: {
  projectId: string; instruction: string;
  onInstructionChange(value: string): void; onGenerate?: () => void;
  generationAction?: ReactNode;
  selectedLabel?: string; selectedPreview?: ReactNode;
  /** Quiet actions for the chosen logo, such as Download PNG. */
  selectedActions?: ReactNode;
  status?: string;
  onShowResult?: () => void;
  /** Presentation only; callback presence remains the availability for deliberate generation. */
  selectionReadState?: "loading" | "unavailable";
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Before the first set there is nothing to change; the draft stays mounted. */
  idle?: boolean;
  /** The step's next action, on the right below the refine box. */
  footer?: ReactNode;
}) {
  const readMessage = selectionReadState === "loading" ? "Loading saved logo details…" : selectionReadState === "unavailable" ? "Saved logo details unavailable." : null;
  return <>
    <form className={styles.conceptsComposer} hidden={idle} aria-label="Logo concept changes" aria-busy={selectionReadState === "loading"} onSubmit={event => { event.preventDefault(); onGenerate?.(); }}>
      <div className={styles.composerHeader}>
        <div className={styles.composerSelection}>{selectedPreview && <span className={styles.composerThumbnail}><Icon name="brands" size={18} />{selectedPreview}</span>}<span>{selectedLabel ?? readMessage ?? "Choose a concept above to change it"}</span></div>
        {(selectedActions || onShowResult) && <div className={styles.composerHeaderActions}>
          {onShowResult && <button type="button" className={styles.secondaryButton} onClick={onShowResult}>View refined logo</button>}
          {selectedActions}
        </div>}
      </div>
      <textarea ref={inputRef} aria-label="Describe a change to this logo" placeholder={readMessage ?? (selectedLabel ? "Describe a change to this logo…" : "Choose a concept, then describe a change…")} value={instruction} maxLength={2000} onChange={event => onInstructionChange(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.repeat && (event.metaKey || event.ctrlKey) && onGenerate) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={2} />
      <div className={styles.composerTools}>
        <p className={styles.composerStatus} role="status">{status}</p>
        {generationAction ?? <button type="submit" className={styles.primaryButton} disabled={!onGenerate} title={onGenerate ? undefined : readMessage ?? status ?? "Choose a concept and describe a change first"}>Refine</button>}
      </div>
    </form>
    {footer && <div className={styles.composerFooter}>{footer}</div>}
  </>;
}
