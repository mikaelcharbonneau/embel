"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppMark } from "@/components/ui/app-mark";
import { Icon } from "@/components/ui/icon";
import type { JourneyStepView } from "@/domain/journey";
import { NavFrame } from "./floating-nav";
import styles from "./journey.module.css";

export type SaveState = "saved" | "saving" | "unsaved" | "error";
const saveLabels: Record<SaveState, string> = { saved: "Saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Not saved" };

/** Inside a project the floating pill shows the brand, the journey steps and
 * save status. "Saved" must only be passed after the server confirms the save;
 * pass null while it is unknown. An empty name means the project is loading. */
export function ProjectBarContent({ projectName, projectControl, steps, saveState }: {
  projectName: string; projectControl?: ReactNode; steps: readonly JourneyStepView[]; saveState: SaveState | null;
}) {
  return <>
    <Link href="/" className={styles.brandIcon} aria-label="Embel home"><AppMark /></Link>
    {projectControl ?? (projectName ? <span className={styles.projectName}>{projectName}</span> : <span className={styles.projectName} role="status">Loading project…</span>)}
    {steps.length > 0 && <>
      <span className={styles.sep} aria-hidden="true" />
      <nav className={styles.stepsNav} aria-label="Brand journey">
        <ol className={styles.steps}>
          {steps.map(step => <li key={step.id}>
            {step.status === "current" ? <span className={styles.step} aria-current="step"><span className={styles.stepMark} aria-hidden="true" /><span className={styles.stepLabel}>{step.label}</span></span>
              : step.status === "done" && step.href ? <Link className={styles.step} href={step.href}><span className={styles.stepMark} aria-hidden="true"><Icon name="check" size={11} /></span><span className={styles.stepLabel}>{step.label}</span><span className="sr-only">, complete</span></Link>
              : step.href ? <Link className={`${styles.step} ${styles.stepNext}`} href={step.href}><span className={styles.stepMark} aria-hidden="true">{step.number}</span><span className={styles.stepLabel}>{step.label}</span><span className="sr-only">, next step</span></Link>
              : <span className={styles.step}><span className={styles.stepMark} aria-hidden="true">{step.number}</span><span className={styles.stepLabel}>{step.label}</span>{step.status === "done" && <span className="sr-only">, complete</span>}</span>}
          </li>)}
        </ol>
      </nav>
    </>}
    {saveState && <>
      <span className={styles.sep} aria-hidden="true" />
      <span className={styles.save} data-state={saveState} role="status">{saveState === "saved" && <Icon name="check" size={13} />}{saveLabels[saveState]}</span>
    </>}
  </>;
}

export function ProjectCapsule({ account, ...content }: {
  projectName: string; projectControl?: ReactNode; steps: readonly JourneyStepView[]; saveState: SaveState | null; account?: ReactNode;
}) {
  return <NavFrame variant="project" account={account}><ProjectBarContent {...content} /></NavFrame>;
}

/** The project name opens a small menu to leave the project. */
export function ProjectMenu({ projectName }: { projectName: string }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = (focus = false) => {
    if (menu.current) menu.current.open = false;
    if (focus) menu.current?.querySelector("summary")?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <details ref={menu} className={styles.tools} onToggle={event => setOpen(event.currentTarget.open)}
    onKeyDown={event => { if (event.key === "Escape" && menu.current?.open) { event.preventDefault(); close(true); } }}>
    <summary className={`${styles.projectName} ${styles.projectSummary}`} aria-label={`Project: ${projectName}. Switch project`}>
      <span className={styles.projectTitle}>{projectName}</span><Icon name="chevron" size={12} style={{ transform: "rotate(90deg)" }} />
    </summary>
    <ul className={styles.menu}>
      <li><Link href="/brands" onClick={() => close()}>All projects</Link></li>
      <li><Link href="/brands/new" onClick={() => close()}>New project</Link></li>
      <li><Link href="/" onClick={() => close()}>Home</Link></li>
    </ul>
  </details>;
}
