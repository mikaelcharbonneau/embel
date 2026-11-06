import Link from "next/link";
import type { ReactNode } from "react";
import { AppMark } from "@/components/ui/app-mark";
import { Icon } from "@/components/ui/icon";
import type { JourneyStepView } from "@/domain/journey";
import styles from "./journey.module.css";

export type SaveState = "saved" | "saving" | "unsaved" | "error";
const saveLabels: Record<SaveState, string> = { saved: "Saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Not saved" };

/** Inside a project the floating pill shows the brand, the four steps and save status.
 * "Saved" must only be passed after the server confirms the save. */
export function ProjectCapsule({ projectName, projectControl, steps, saveState, account }: {
  projectName: string; projectControl?: ReactNode; steps: readonly JourneyStepView[]; saveState: SaveState; account?: ReactNode;
}) {
  return <header className={styles.navWrap}>
    <div className={styles.capsule}>
      <Link href="/" className={styles.brandIcon} aria-label="Embel home"><AppMark /></Link>
      {projectControl ?? <span className={styles.projectName}>{projectName}</span>}
      <span className={styles.sep} aria-hidden="true" />
      <nav className={styles.stepsNav} aria-label="Brand journey">
        <ol className={styles.steps}>
          {steps.map(step => <li key={step.id}>
            {step.status === "current" ? <span className={styles.step} aria-current="step"><span className={styles.stepMark} aria-hidden="true" /><span className={styles.stepLabel}>{step.label}</span></span>
              : step.status === "done" && step.href ? <Link className={styles.step} href={step.href}><span className={styles.stepMark} aria-hidden="true"><Icon name="check" size={11} /></span><span className={styles.stepLabel}>{step.label}</span><span className="sr-only">, complete</span></Link>
              : <span className={styles.step}><span className={styles.stepMark} aria-hidden="true">{step.number}</span><span className={styles.stepLabel}>{step.label}</span>{step.status === "done" && <span className="sr-only">, complete</span>}</span>}
          </li>)}
        </ol>
      </nav>
      <span className={styles.sep} aria-hidden="true" />
      <span className={styles.save} data-state={saveState} role="status">{saveState === "saved" && <Icon name="check" size={13} />}{saveLabels[saveState]}</span>
      {account && <div className={styles.end}>{account}</div>}
    </div>
  </header>;
}
