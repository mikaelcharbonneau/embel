import type { ReactNode } from "react";
import { AppMark } from "@/components/ui/app-mark";
import styles from "./journey.module.css";

/** One Embel turn in the project conversation. `meta` names the part, e.g. "Competitors · 1 of 3". */
export function EmbelMessage({ meta, children }: { meta?: string; children: ReactNode }) {
  return <div className={styles.message}>
    <span className={styles.avatar} aria-hidden="true"><AppMark /></span>
    <div className={styles.messageBody}>
      <p className={styles.meta}>{meta ? `Embel · ${meta}` : "Embel"}</p>
      {children}
    </div>
  </div>;
}

/** The person's own message, aligned to the right. */
export function UserMessage({ children }: { children: ReactNode }) {
  return <div className={styles.user}>
    <span className={styles.meta}>You</span>
    <p className={styles.bubble}>{children}</p>
  </div>;
}
