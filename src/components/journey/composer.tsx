"use client";

import { useId, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import styles from "./journey.module.css";

type ComposerProps = {
  label: string;
  placeholder: string;
  value: string;
  onChange(value: string): void;
  onSubmit(value: string): void;
  submitLabel?: string;
  /** What a change request applies to, e.g. "Concept 3". */
  target?: string;
  onClearTarget?: () => void;
  /** Leading controls such as attach and dictate. */
  tools?: ReactNode;
  disabled?: boolean;
};

/** The project conversation's input. Enter sends; Shift+Enter adds a line. */
export function Composer({ label, placeholder, value, onChange, onSubmit, submitLabel = "Send", target, onClearTarget, tools, disabled = false }: ComposerProps) {
  const id = useId();
  const ready = !disabled && value.trim().length > 0;
  const submit = () => { if (ready) onSubmit(value.trim()); };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  return <form className={styles.composer} aria-label={label} onSubmit={event => { event.preventDefault(); submit(); }}>
    {target && <p className={styles.target}>Changing {target}{onClearTarget && <button type="button" className={styles.targetClear} aria-label={`Stop changing ${target}`} onClick={onClearTarget}><Icon name="close" size={12} /></button>}</p>}
    <label className="sr-only" htmlFor={id}>{label}</label>
    <textarea id={id} className={styles.textarea} rows={2} value={value} placeholder={placeholder} disabled={disabled}
      onChange={event => onChange(event.target.value)} onKeyDown={keyDown} />
    <div className={styles.composerFooter}>
      {tools}
      <span className={styles.spacer} />
      <button type="submit" className={styles.send} disabled={!ready} aria-label={submitLabel}><Icon name="arrow-up" size={16} /></button>
    </div>
  </form>;
}
