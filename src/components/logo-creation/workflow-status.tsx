import Link from "next/link";
import type { LogoWorkspaceV2 } from "../../domain/logo-workspace";
import styles from "./logo-creation.module.css";
import stage from "@/styles/branding-stage.module.css";

const stageNames = { brief_references: "Logo brief and references", concepts: "Logo concepts", vector: "Vector logo", refinements: "Logo refinements", directions: "Creative direction", deliverables: "Brand files" };

export function LogoInputStatus({ workspace }: { workspace: LogoWorkspaceV2 }) {
  if (!workspace.staleStages.length) return null;
  return <section className={styles.warning} aria-label="Logo inputs need review">
    <h2 className={stage.sectionHeading}>Saved inputs have changed</h2>
    <p>Your earlier logo versions are kept. Review the affected stages before starting new work.</p>
    <ul>{workspace.staleStages.map(({ stage, reasons }) => <li key={stage}>{stageNames[stage]}: {reasons.includes("project_revision_changed")
      ? "your Strategy changed since. Use Reuse Strategy to bring the latest details into your brief."
      : "was made with earlier choices. Review it against your current brief."}</li>)}</ul>
  </section>;
}

export function LogoIdentityContinuation({ workspace, blocked, hasSelection }: { workspace: LogoWorkspaceV2; blocked: boolean; hasSelection: boolean }) {
  const logoNeedsReview = workspace.staleStages.some(({ stage }) => stage === "brief_references" || stage === "concepts" || stage === "refinements");
  const ready = hasSelection && !logoNeedsReview;
  return <section className={styles.panel} aria-label="Continue from logo to identity">
    <h2 className={stage.sectionHeading}>{ready ? "Explore your creative direction" : "Choose your logo concept"}</h2>
    <p className={styles.note}>{ready ? "Compare three brand boards using your chosen logo, with colors, typography and example uses."
      : "Choose a current logo concept to build your visual identity around it."}</p>
    {blocked ? <p className={styles.note}>Finish saving your changes before continuing.</p>
      : ready ? <Link className={styles.primaryButton} href={`/brands/account/${workspace.projectId}/logo/directions`}>Continue to Creative direction</Link>
      : <Link className={styles.secondaryButton} href={`/brands/account/${workspace.projectId}/logo`}>Choose a logo concept</Link>}
  </section>;
}
