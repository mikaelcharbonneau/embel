"use client";
import { ContextDetails } from "@/components/ui/context-details";
import Link from "next/link";
import type { AccountProject } from "@/domain/project-api";
import { getProjectHandoff } from "@/domain/project-handoff";
export type ProjectContinuityPanelProps = { project: AccountProject; dirty: boolean; conflicted: boolean; busy: boolean };
export function ProjectContinuityPanel({ project, dirty, conflicted, busy }: ProjectContinuityPanelProps) {
 const handoff = getProjectHandoff(project);
 const blocked = dirty || conflicted || busy;
 return <section className="account-notice project-continuity" aria-label="Brand context and continuation">
  <ContextDetails className="project-continuity-details" title={<>Saved project details <span>Version {project.current_revision}</span></>}><dl>
   <div><dt>{handoff.briefReviewed ? "Reviewed brief" : "Brief needs review"}</dt><dd>{handoff.briefReviewed ? `${project.context.activity} · ${project.context.offering}` : project.context.description || "No brief saved yet"}</dd></div>
   <div><dt>{handoff.strategyReady ? "Strategy reviewed" : "Strategy needs review"}</dt><dd>{handoff.strategyReady ? project.context.positioning : "Saved content stays available until you review it."}</dd></div>
   {(handoff.savedName || project.context.intake.suppliedName) && <div><dt>{handoff.savedName ? "Saved name" : "Provided name"}</dt><dd>{handoff.savedName ?? project.context.intake.suppliedName}</dd></div>}
  </dl></ContextDetails>
  {handoff.savedName && !handoff.strategyReady && <p>Your saved name is kept. Review it against your Strategy after the missing reviews are complete.</p>}
  {handoff.reviews.length > 0 && <><h2>Continue your Strategy</h2><ul>{handoff.reviews.map(step => <li key={step.key}><a className="text-link" href={`#strategy-${step.anchor}`}>{step.label}</a></li>)}</ul></>}
  {handoff.next.stage !== "strategy" && <>{blocked ? <button type="button" className="button secondary small" disabled>{handoff.next.label}</button> : <Link className="button secondary small" href={handoff.next.href}>{handoff.next.label}</Link>}{blocked && <p>Save or resolve your edits before continuing.</p>}</>}
 </section>;
}
