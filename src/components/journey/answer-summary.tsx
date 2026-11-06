import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import styles from "./journey.module.css";

/** A finished question, collapsed to its answer with a way back to change it. */
export function AnswerSummary({ question, children, onEdit, disabled = false }: {
  question: string; children: ReactNode; onEdit?: () => void; disabled?: boolean;
}) {
  return <section className={styles.summary} aria-label={`Your answer: ${question}`}>
    <div className={styles.summaryCopy}>
      <h3 className={styles.summaryQuestion}>{question}</h3>
      <div className={styles.summaryAnswer}>{children}</div>
    </div>
    {onEdit && <button type="button" className={styles.pillButton} disabled={disabled} aria-label={`Edit your answer: ${question}`} onClick={onEdit}>Edit answer</button>}
  </section>;
}

/** A compact link to an earlier, completed part of the journey. */
export function EarlierAnswerLink({ href, label, value, media }: { href: string; label: string; value?: string; media?: ReactNode }) {
  return <Link className={styles.earlier} href={href}>
    {media ?? <span className={styles.earlierCheck} aria-hidden="true"><Icon name="check" size={12} /></span>}
    <span className={styles.earlierLabel}>{label}</span>
    {value && <span className={styles.earlierValue}>{value}</span>}
  </Link>;
}
