import Link from "next/link";
import type { LogoWorkspaceV2 } from "../../domain/logo-workspace";
import styles from "./logo-creation.module.css";

const stageNames = { brief_references: "Logo brief and references", concepts: "Logo concepts", vector: "Vector logo", refinements: "Logo refinements", directions: "Identity directions", deliverables: "Brand files" };

export function LogoInputStatus({ workspace }: { workspace: LogoWorkspaceV2 }) {
  if (!workspace.staleStages.length) return null;
  return <section className={styles.warning} aria-label="Logo inputs need review">
    <h2>Saved inputs have changed</h2>
    <p>Your earlier logo versions are kept. Review the affected stages before starting new work.</p>
    <ul>{workspace.staleStages.map(({ stage, reasons }) => <li key={stage}>{stageNames[stage]}: {reasons.includes("project_revision_changed")
      ? "the project context has a newer saved revision. Use Reuse Strategy to review the current context in your brief."
      : "uses an earlier saved input. Review it against the current brief and selections."}</li>)}</ul>
  </section>;
}

export function LogoIdentityContinuation({ workspace, blocked, hasSelection }: { workspace: LogoWorkspaceV2; blocked: boolean; hasSelection: boolean }) {
  const logoNeedsReview = workspace.staleStages.some(({ stage }) => stage !== "directions" && stage !== "deliverables");
  const ready = Boolean(workspace.approvedLogo && !logoNeedsReview);
  return <section className={styles.panel} aria-label="Continue from logo to identity">
    <h2>{ready ? "Build around your approved logo" : "Review your logo before Identity"}</h2>
    <p className={styles.note}>{ready ? "Your approved vector logo is ready for colors, typography and supporting graphics."
      : "Select an image, convert it to a vector, then review and approve the result. Each saved image and vector version stays in its history."}</p>
    {blocked ? <p className={styles.note}>Resolve the pending request or unsaved edits before continuing.</p>
      : ready ? <Link className={styles.primaryButton} href={`/brands/account/${workspace.projectId}/logo/directions`}>Continue to Identity directions</Link>
      : hasSelection || workspace.stages.vector || workspace.stages.refinements?.id ? <Link className={styles.secondaryButton} href={`/brands/account/${workspace.projectId}/logo/vector`}>Review vector logo</Link>
      : <p className={styles.note}>Choose a saved concept or refinement to continue.</p>}
  </section>;
}
