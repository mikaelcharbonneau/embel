import Link from "next/link";
import { useId } from "react";
import styles from "./output-prerequisites.module.css";

type Prerequisite = { label: string; status: string };
/** Presentation only. Approval and admission remain authoritative in the owning controllers. */
export function OutputPrerequisites({ heading, description, steps, action }: {
  heading: string;
  description: string;
  steps: readonly Prerequisite[];
  action?: { href: string; label: string };
}) {
  const title = useId();
  return <section className={styles.summary} aria-labelledby={title}>
    <div className={styles.heading}><div><h3 id={title}>{heading}</h3><p>{description}</p></div>
      {action && <Link className={styles.action} href={action.href}>{action.label}</Link>}
    </div>
    <dl className={styles.steps}>{steps.map(step => <div key={step.label}><dt>{step.label}</dt><dd>{step.status}</dd></div>)}</dl>
  </section>;
}
