"use client";

import { useId, type ReactNode } from "react";
import { logoTypeSchema, type LogoType } from "@/domain/logo-vector";
import { LOGO_TYPE_LABELS } from "./presentation";
import styles from "./logo-creation.module.css";

const descriptions: Record<LogoType, string> = {
  wordmark: "The name, set in distinctive type.",
  lettermark_monogram: "Initials or a single letter.",
  pictorial: "A recognizable picture or icon.",
  abstract: "A shape that suggests an idea.",
  combination: "A symbol together with the name.",
  emblem: "The name inside a badge or seal.",
  mascot: "A character that represents the brand.",
};

/** Identity · Logo: the kinds of logo the six concepts are spread across. The
 * choice edits the saved brief, which saves on its own as on the brief form.
 * `note` explains what a change affects once concepts exist. */
export function LogoTypesQuestion({ value, onChange, disabled = false, action, note }: { value: readonly LogoType[]; onChange?: (types: LogoType[]) => void; disabled?: boolean; action?: ReactNode; note?: string }) {
  const id = useId();
  return <fieldset className="logo-types-question" aria-describedby={`${id}-hint`}>
    <legend className="sr-only">Which logo types should I explore?</legend>
    <h2 aria-hidden="true">Which logo types should I explore?</h2>
    <p id={`${id}-hint`}>Choose as many as you like. The six concepts are spread across them.</p>
    <div className="logo-types-options">
      {logoTypeSchema.options.map(type => <button key={type} type="button" className="naming-approach-option" aria-pressed={value.includes(type)} disabled={disabled || !onChange}
        onClick={() => onChange?.(logoTypeSchema.options.filter(option => option === type ? !value.includes(type) : value.includes(option)))}>
        <strong>{LOGO_TYPE_LABELS[type]}</strong><span>{descriptions[type]}</span>
      </button>)}
    </div>
    {value.length === 7 && <p role="status" className="logo-types-note">With all seven chosen, one type waits for your next set of concepts.</p>}
    {note && <p className="logo-types-note">{note}</p>}
    <div className="logo-types-footer">
      <p role="status" className="logo-types-count">{value.length === 0 ? "Choose at least one type" : value.length === 1 ? "1 type chosen" : `${value.length} types chosen`}</p>
      {action}
    </div>
  </fieldset>;
}

/** Once concepts exist: the chosen logo types in one line, with a way back to
 * the question above so the next concepts can use different types. */
export function LogoTypesSummary({ value, onChange, disabled = false }: { value: readonly LogoType[]; onChange?: () => void; disabled?: boolean }) {
  return <div className="logo-types-summary" role="group" aria-label="Logo types">
    <p><span>Logo types</span>{value.length ? value.map(type => LOGO_TYPE_LABELS[type]).join(", ") : "None chosen"}</p>
    <button className={styles.secondaryButton} type="button" disabled={disabled || !onChange} onClick={onChange}>Change logo types</button>
  </div>;
}
