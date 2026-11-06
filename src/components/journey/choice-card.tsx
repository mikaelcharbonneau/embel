"use client";

import type { ReactNode } from "react";
import styles from "./journey.module.css";

type ChoiceCardProps = {
  type: "radio" | "checkbox";
  name: string;
  value: string;
  checked: boolean;
  onChange(checked: boolean): void;
  title: ReactNode;
  /** Short label such as "Recommended". */
  badge?: ReactNode;
  /** Leading visual, such as a competitor logo. */
  media?: ReactNode;
  /** Content outside the clickable target, such as source links. */
  footer?: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
};

/** A whole card is the choice: clicking anywhere on it selects it. The real
 * input stays in the card so keyboard and screen reader behaviour is native. */
export function ChoiceCard({ type, name, value, checked, onChange, title, badge, media, footer, disabled = false, children }: ChoiceCardProps) {
  return <div className={styles.choice} data-checked={checked} data-disabled={disabled}>
    <label className={styles.choiceTarget}>
      {media}
      <span className={styles.choiceContent}>
        <span className={styles.choiceTitle}>{title}{badge && <span className={styles.badge}>{badge}</span>}</span>
        {children}
      </span>
      <input className={styles.choiceInput} type={type} name={name} value={value} checked={checked} disabled={disabled}
        onChange={event => onChange(event.currentTarget.checked)} />
    </label>
    {footer}
  </div>;
}
