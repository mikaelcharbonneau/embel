"use client";
import Link from "next/link";
import type { NamingFeedEntry } from "@/domain/naming-brain";
import type { ProjectNameEntry } from "@/domain/project-naming";

export function NamingInspect({ entry, claims, selected, pending, blocked, onBack, onUse, onWorkshop }: {
  claims?: NamingFeedEntry["publishedClaims"]; entry: ProjectNameEntry; selected: boolean; pending: boolean; blocked: boolean; onBack: () => void; onUse: () => void; onWorkshop: () => void;
}) {
  return <section className="project-name-inspect" aria-label="Inspect name"><header className="project-workbench-heading"><div><h2>A closer look</h2><p>{selected ? "Selected name" : "Candidate · not selected"}</p></div><button type="button" className="button secondary small" onClick={onBack}>Back to results</button></header>
    <div className="project-name-hero"><h3>{entry.candidate.value}</h3><p>{selected ? "Your saved selection" : "Inspecting keeps your current selection unchanged."}</p></div>
    <div className="project-name-explanation"><article><h3>Creative interpretation</h3><p>{entry.candidate.rationale}</p></article><article><h3>Things to consider</h3><p>{entry.candidate.caution || "No additional caution was recorded. This is not clearance or proof of availability."}</p></article></div>
    {claims?.length ? <section className="naming-published-claims" aria-label="Recorded factual claims"><h3>Recorded factual claims</h3><ul>{claims.map(claim => <li key={claim.claimKey}><p>{claim.statement}</p>{claim.evidence.map((evidence, index) => <blockquote key={`${evidence.sourceKey}:${index}`}>{evidence.quote}</blockquote>)}</li>)}</ul><p>These findings concern the statements shown. They do not establish name availability or broader cultural acceptance.</p></section> : null}
    <div className="project-name-checks">{([['Domains', '/domains'], ['Handles', '/handles'], ['Trademarks', '/trademarks']] as const).map(([label, href]) => <article key={href}><h3>{label}</h3><p>Not checked</p><Link className="button secondary small" href={href}>Open {label.toLowerCase()}</Link></article>)}</div>
    <div className="project-naming-actions"><button type="button" className="button secondary small" disabled={pending || blocked} onClick={onWorkshop}>Explore variations</button><button type="button" className="button primary small" disabled={pending || blocked || selected} onClick={onUse}>{selected ? "Selected name" : "Use this name"}</button></div>
  </section>;
}
