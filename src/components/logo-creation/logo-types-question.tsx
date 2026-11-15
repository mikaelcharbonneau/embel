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
 * The choice edits the saved brief, which saves on its own as on the brief form. `note` is the no-credits note;
 * `action` is the start button when the step has its own (no Send-driven reply box). */
export function LogoTypesQuestion({
  value,
  onChange,
  disabled = false,
  action,
  note,
}: {
  value: readonly LogoType[];
  onChange?: (types: LogoType[]) => void;
  disabled?: boolean;
  action?: ReactNode;
  note?: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className={styles.typesQuestion}>
      <legend className={styles.stepTitle}>Which logo types should I explore?</legend>
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
      {note}
      {action && <div className={styles.typesFooter}>{action}</div>}
    </fieldset>
  );
}

/** Once concepts exist: the way back to the question, which shows the chosen types, so the next concepts can use
 * different ones. */
export function LogoTypesChange({
  onChange,
  disabled = false,
  inline = false,
}: {
  onChange?: () => void;
  disabled?: boolean;
  /** A link under Embel's message in the Workspace chat. */
  inline?: boolean;
}) {
  return inline ? (
    <p className={styles.typesLine}>
      <button type="button" className="e-link" disabled={disabled || !onChange} onClick={onChange}>
        Change logo types
      </button>
    </p>
  ) : (
    <Button size="sm" variant="quiet" disabled={disabled || !onChange} onClick={onChange}>
      Change logo types
    </Button>
  );
}
