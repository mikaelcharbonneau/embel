"use client";
import { ContextDetails } from "@/components/ui/context-details";
import Link from "next/link";
import type { AccountProject } from "@/domain/project-api";
import { getProjectHandoff } from "@/domain/project-handoff";
import type { StandalonePromotionSource } from "@/domain/standalone-promotion";
export type ProjectContinuityPanelProps = { project: AccountProject; source: StandalonePromotionSource | null; dirty: boolean; conflicted: boolean; expanding: boolean; onExpand(): Promise<void> };
export function ProjectContinuityPanel({ project, source, dirty, conflicted, expanding, onExpand }: ProjectContinuityPanelProps) {
 const handoff = getProjectHandoff(project);
 const blocked = dirty || conflicted || expanding;
 const ownedSource = source?.ownerId === project.owner_id.toLowerCase() ? source : null;
 return <section className="account-notice project-continuity" aria-label="Brand context and continuation">
  {ownedSource && <p>Started from saved {ownedSource.selection.tool} version {ownedSource.workspaceRevision}.{ownedSource.contextSource && <> Context carried from {ownedSource.contextSource.projectTitle}, version {ownedSource.contextSource.projectRevision}.</>}</p>}
  <ContextDetails className="project-continuity-details" title={<>Saved project details <span>Version {project.current_revision}</span></>}><dl>
   <div><dt>{handoff.briefReviewed ? "Reviewed brief" : "Brief needs review"}</dt><dd>{handoff.briefReviewed ? `${project.context.activity} · ${project.context.offering}` : project.context.description || "No brief saved yet"}</dd></div>
   <div><dt>{handoff.strategyReady ? "Strategy reviewed" : "Strategy needs review"}</dt><dd>{handoff.strategyReady ? project.context.positioning : "Saved content stays available until you review it."}</dd></div>
   {(handoff.savedName || project.context.intake.suppliedName) && <div><dt>{handoff.savedName ? "Saved name" : "Provided name"}</dt><dd>{handoff.savedName ?? project.context.intake.suppliedName}</dd></div>}
  </dl></ContextDetails>
  {handoff.savedName && !handoff.strategyReady && project.scope === "complete_brand" && <p>Your saved name is kept. Review it against your Strategy after the missing reviews are complete.</p>}
  {project.scope !== "complete_brand" && <><p>Continue this saved work as a complete brand. Its context and earlier revisions are retained.</p><button className="button secondary small" type="button" disabled={dirty || conflicted || expanding} onClick={() => void onExpand()}>{expanding ? "Expanding…" : "Expand to complete brand"}</button>{(dirty || conflicted) && <p>Save or resolve the current edits before expanding.</p>}</>}
  {handoff.reviews.length > 0 && <><h2>Continue your Strategy</h2><ul>{handoff.reviews.map(step => <li key={step.key}><a className="text-link" href={`#strategy-${step.anchor}`}>{step.label}</a></li>)}</ul></>}
  {handoff.next.stage !== "strategy" && <>{blocked ? <button type="button" className="button secondary small" disabled>{handoff.next.label}</button> : <Link className="button secondary small" href={handoff.next.href}>{handoff.next.label}</Link>}{blocked && <p>Save or resolve your edits before continuing.</p>}</>}
  {ownedSource && <p className="field-hint">The saved origin is a frozen input source. No availability check, account verification or trademark clearance is implied.</p>}
 </section>;
}
