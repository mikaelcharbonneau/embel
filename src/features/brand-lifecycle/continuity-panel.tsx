"use client";
import type { AccountProject } from "@/domain/project-api";
import { missingStrategy } from "@/domain/projects";
import type { StandalonePromotionSource } from "@/domain/standalone-promotion";
export type ProjectContinuityPanelProps = { project: AccountProject; source: StandalonePromotionSource | null; dirty: boolean; conflicted: boolean; expanding: boolean; onExpand(): Promise<void> };
const guidance = {
 reformulation: { label: "Review the saved brief", anchor: "brief" },
 competitors: { label: "Review competitors", anchor: "competitors" },
 audience: { label: "Choose an audience", anchor: "audience" },
 personality: { label: "Review personality", anchor: "personality" },
 positioning: { label: "Review positioning", anchor: "positioning" },
} as const;
export function ProjectContinuityPanel({ project, source, dirty, conflicted, expanding, onExpand }: ProjectContinuityPanelProps) {
 const missing = missingStrategy(project.context);
 const ownedSource = source?.ownerId === project.owner_id.toLowerCase() ? source : null;
 return <section className="account-notice" aria-label="Brand context and continuation">
  {ownedSource && <p>Started from saved {ownedSource.selection.tool} version {ownedSource.workspaceRevision}.{ownedSource.contextSource && <> Context carried from {ownedSource.contextSource.projectTitle}, version {ownedSource.contextSource.projectRevision}.</>}</p>}
  {project.scope !== "complete_brand" && <><p>Continue this saved work as a complete brand. Its context and earlier revisions are retained.</p><button className="button secondary small" type="button" disabled={dirty || conflicted || expanding} onClick={() => void onExpand()}>{expanding ? "Expanding…" : "Expand to complete brand"}</button>{(dirty || conflicted) && <p>Save or resolve the current edits before expanding.</p>}</>}
  {missing.length > 0 && <><h2>Continue your Strategy</h2><ul>{missing.map(step => <li key={step}><a className="text-link" href={`#strategy-${guidance[step].anchor}`}>{guidance[step].label}</a></li>)}</ul></>}
  {ownedSource && <p className="field-hint">The saved origin is a frozen input source. No availability check, account verification or trademark clearance is implied.</p>}
 </section>;
}
