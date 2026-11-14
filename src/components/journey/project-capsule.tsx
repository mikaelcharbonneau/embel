"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { AppMark } from "@/components/ui/app-mark";
import { Icon } from "@/components/ui/icon";
import { Menu, type MenuItem } from "@/components/ui/menu";
import type { JourneyStepView } from "@/domain/journey";
import { NavFrame } from "./floating-nav";
import { JOURNEY_SECTION_EVENT, journeySectionOfHash } from "./project-header";
import styles from "./journey.module.css";

export type SaveState = "saved" | "saving" | "unsaved" | "error";
const saveLabels: Record<SaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved changes",
  error: "Not saved",
};

/** A step whose section is on screen in the project conversation scrolls there
 * instead of reloading the page; otherwise the link opens it normally. */
function showSection(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(event.currentTarget.href, window.location.href);
  const step = journeySectionOfHash(url.hash);
  const section = step && url.pathname === window.location.pathname ? document.getElementById(url.hash.slice(1)) : null;
  if (!section) return;
  event.preventDefault();
  section.dispatchEvent(new CustomEvent(JOURNEY_SECTION_EVENT, { bubbles: true, detail: step }));
}

/** Inside a project the floating pill shows the brand, the journey steps and
 * save status. "Saved" must only be passed after the server confirms the save;
 * pass null while it is unknown. An empty name means the project is loading. */
export function ProjectBarContent({
  projectName,
  projectControl,
  steps,
  saveState,
}: {
  projectName: string;
  projectControl?: ReactNode;
  steps: readonly JourneyStepView[];
  saveState: SaveState | null;
}) {
  return (
    <>
      <Link href="/" className={styles.brandIcon} aria-label="Embel home">
        <AppMark />
      </Link>
      {projectControl ??
        (projectName ? (
          <span className={styles.projectName} translate="no">
            {projectName}
          </span>
        ) : (
          <span className={styles.projectName} role="status">
            Loading project…
          </span>
        ))}
      {steps.length > 0 && (
        <>
          <span className={styles.sep} aria-hidden="true" />
          {/* Decision 8: the current step has no fill; its ring-and-dot mark and ink text show it. */}
          <nav className={styles.stepsNav} aria-label="Brand journey">
            <ol className="e-steps">
              {steps.map((step) => {
                const state = step.status === "done" ? "complete" : step.status === "current" ? undefined : "upcoming";
                return (
                  <li key={step.id}>
                    {step.status === "current" ? (
                      <span className="e-step" aria-current="step" data-complete={step.complete || undefined}>
                        <span className="e-step__mark" aria-hidden="true" />
                        <span>{step.label}</span>
                      </span>
                    ) : step.status === "done" && step.href ? (
                      <Link className="e-step" data-state={state} href={step.href} onClick={showSection}>
                        <span className="e-step__mark" aria-hidden="true">
                          <Icon name="check" size="sm" />
                        </span>
                        <span>{step.label}</span>
                        <span className="e-sr">, complete</span>
                      </Link>
                    ) : step.href ? (
                      <Link className="e-step e-step--next" data-state={state} href={step.href} onClick={showSection}>
                        <span className="e-step__mark" aria-hidden="true">
                          {step.number}
                        </span>
                        <span>{step.label}</span>
                        <span className="e-sr">, next step</span>
                      </Link>
                    ) : (
                      <span
                        className="e-step"
                        data-state={state}
                        aria-disabled={step.status === "done" ? undefined : "true"}
                      >
                        <span className="e-step__mark" aria-hidden="true">
                          {step.status === "done" ? <Icon name="check" size="sm" /> : step.number}
                        </span>
                        <span>{step.label}</span>
                        {step.status === "done" && <span className="e-sr">, complete</span>}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <StepsMenu steps={steps} />
        </>
      )}
      {saveState && (
        <>
          <span className={styles.sep} aria-hidden="true" />
          <span className={styles.save} data-state={saveState} role="status">
            {saveState === "saved" && <Icon name="check" size={13} />}
            {saveLabels[saveState]}
          </span>
        </>
      )}
    </>
  );
}

/** Where the four step names do not fit (below 1280 px beside the side chat, below 1024 px everywhere), they collapse
 * into one menu button that names the current step: "Identity · 3 of 4". */
function StepsMenu({ steps }: { steps: readonly JourneyStepView[] }) {
  const current = steps.find((step) => step.status === "current") ?? steps[0]!;
  const items: MenuItem[] = steps.map((step) =>
    step.status === "current"
      ? { kind: "choice", label: step.label, checked: true, onSelect: () => undefined }
      : step.href
        ? {
            kind: "link",
            label: `${step.label}${step.status === "done" ? ", complete" : ", next step"}`,
            href: step.href,
          }
        : { kind: "action", label: step.label, disabled: true, onSelect: () => undefined },
  );
  return (
    <Menu
      align="start"
      className="e-steps-compact"
      items={items}
      trigger={(props) => (
        <button type="button" className="e-nav__item" {...props}>
          <span>
            {current.label} · {current.number} of {steps.length}
          </span>
          <Icon name="chevron-down" size="sm" />
        </button>
      )}
    />
  );
}

export function ProjectCapsule({
  account,
  ...content
}: {
  projectName: string;
  projectControl?: ReactNode;
  steps: readonly JourneyStepView[];
  saveState: SaveState | null;
  account?: ReactNode;
}) {
  return (
    <NavFrame variant="project" account={account}>
      <ProjectBarContent {...content} />
    </NavFrame>
  );
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
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <details
      ref={menu}
      className={styles.tools}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu.current?.open) {
          event.preventDefault();
          close(true);
        }
      }}
    >
      <summary
        className={`${styles.projectName} ${styles.projectSummary}`}
        aria-label={`Project: ${projectName}. Switch project`}
      >
        <span className={styles.projectTitle} translate="no">
          {projectName}
        </span>
        <Icon name="chevron" size={12} style={{ transform: "rotate(90deg)" }} />
      </summary>
      <ul className={styles.menu}>
        <li>
          <Link href="/brands" onClick={() => close()}>
            All projects
          </Link>
        </li>
        <li>
          <Link href="/" onClick={() => close()}>
            New project
          </Link>
        </li>
        <li>
          <Link href="/" onClick={() => close()}>
            Home
          </Link>
        </li>
      </ul>
    </details>
  );
}
