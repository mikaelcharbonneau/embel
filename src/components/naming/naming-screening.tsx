"use client";

import { Icon, type IconName } from "@/components/ui/icon";

const checks: ReadonlyArray<{ title: string; icon: IconName; description: string }> = [
  { title: "Domains", icon: "domains", description: "Domain availability and pricing need a connected domain provider." },
  { title: "Handles", icon: "handles", description: "Handle availability needs a verified platform check. An absent profile is not confirmation." },
  { title: "Trademarks", icon: "trademarks", description: "Trademark screening needs a connected source, territories and goods or services." },
];

export function NamingScreening({ name, earlierContext, pending, onChangeName }: { name: string; earlierContext: boolean; pending: boolean; onChangeName: () => void }) {
  return <section className="project-naming-screening" aria-label="Name screening">
    <div className="project-naming-selected">
      <div><span className="project-naming-eyebrow">Selected name</span><h2 id="project-naming-screening-heading" tabIndex={-1}>{name}</h2>{earlierContext ? <p>This name came from an earlier strategy context.</p> : null}</div>
      <button className="button secondary small" type="button" disabled={pending} onClick={onChangeName}>Change name<Icon name="pencil" size={14} /></button>
    </div>
    <div className="project-naming-screening-grid">{checks.map(check => <article key={check.title}>
      <Icon name={check.icon} size={22} /><h3>{check.title}</h3><p className="project-naming-screening-status">Not checked — integration unavailable</p>
      <p id={`project-naming-${check.icon}-unavailable`}>{check.description}</p><button type="button" className="button secondary small" disabled aria-describedby={`project-naming-${check.icon}-unavailable`}>Check {check.title.toLowerCase()}</button>
    </article>)}</div>
    <p className="project-naming-muted">Choosing a name does not purchase a domain, reserve a handle or establish trademark clearance.</p>
  </section>;
}
