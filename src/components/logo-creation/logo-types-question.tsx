"use client";

import { useId, type ReactNode } from "react";
import { logoTypeSchema, type LogoType } from "@/domain/logo-vector";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/choice";
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

/** The chosen types in the canonical order, with `type` turned on or off. */
export function toggleLogoType(value: readonly LogoType[], type: LogoType): LogoType[] {
  return logoTypeSchema.options.filter((option) => (option === type ? !value.includes(type) : value.includes(option)));
}

/** Identity · Logo: the kinds of logo the six concepts are spread across, as choice cards (choose any that apply).
 * The choice edits the saved brief, which saves on its own as on the brief form. `note` explains what a change
 * affects once concepts exist; `action` is the start button when the step has its own (no Send-driven reply box). */
export function LogoTypesQuestion({
  value,
  onChange,
  disabled = false,
  action,
  note,
  inReply = false,
}: {
  value: readonly LogoType[];
  onChange?: (types: LogoType[]) => void;
  disabled?: boolean;
  action?: ReactNode;
  note?: ReactNode;
  /** The chosen types also sit in the reply box as chips. */
  inReply?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className={styles.typesQuestion} aria-describedby={`${id}-hint`}>
      <legend className={styles.stepTitle}>Which logo types should I explore?</legend>
      <p id={`${id}-hint`} className="e-muted">
        Choose as many as you like. The six concepts are spread across them
        {inReply ? ", and each one you choose is added to your reply." : "."}
      </p>
      <div className={styles.typesGrid}>
        {logoTypeSchema.options.map((type) => (
          <ChoiceCard
            key={type}
            multiple
            name={`${id}-logo-types`}
            value={type}
            title={LOGO_TYPE_LABELS[type]}
            description={descriptions[type]}
            checked={value.includes(type)}
            disabled={disabled || !onChange}
            onChange={() => onChange?.(toggleLogoType(value, type))}
          />
        ))}
      </div>
      {value.length === 7 && (
        <p role="status" className="e-muted">
          With all seven chosen, one type waits for your next set of concepts.
        </p>
      )}
      {note && <p className="e-muted">{note}</p>}
      <div className={styles.typesFooter}>
        <p role="status" className="e-muted">
          {value.length === 0
            ? "Choose at least one type"
            : value.length === 1
              ? "1 type chosen"
              : `${value.length} types chosen`}
        </p>
        {action}
      </div>
    </fieldset>
  );
}

/** Once concepts exist: the chosen logo types in one line, with a way back to the question so the next concepts can
 * use different types. */
export function LogoTypesSummary({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly LogoType[];
  onChange?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.typesSummary} role="group" aria-label="Logo types">
      <p className="e-muted">
        Logo types: {value.length ? value.map((type) => LOGO_TYPE_LABELS[type]).join(", ") : "None chosen"}
      </p>
      <Button size="sm" variant="quiet" disabled={disabled || !onChange} onClick={onChange}>
        Change logo types
      </Button>
    </div>
  );
}
