"use client";

import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/icon";

const checks: ReadonlyArray<{ title: string; icon: IconName; href: string; description: string }> = [
  { title: "Domains", icon: "domains", href: "/domains", description: "Choose an exact domain in the Domains tool and review the available checks." },
  { title: "Handles", icon: "handles", href: "/handles", description: "Choose a platform and handle to check. An absent profile is not confirmation." },
  { title: "Trademarks", icon: "trademarks", href: "/trademarks", description: "Choose territories and goods or services for a preliminary trademark review." },
];

export function NamingScreening({ name, earlierContext, pending, onChangeName }: { name: string; earlierContext: boolean; pending: boolean; onChangeName: () => void }) {
  return <section className="project-naming-screening" aria-label="Name screening">
    <div className="project-naming-selected">
      <div><span className="project-naming-eyebrow">Selected name</span><h2 id="project-naming-screening-heading" tabIndex={-1}>{name}</h2>{earlierContext ? <p>This name came from an earlier strategy context.</p> : null}</div>
      <button className="button secondary small" type="button" disabled={pending} onClick={onChangeName}>Change name<Icon name="pencil" size={14} /></button>
    </div>
    <div className="project-naming-screening-grid">{checks.map(check => <article key={check.title}>
      <Icon name={check.icon} size={22} /><h3>{check.title}</h3><p className="project-naming-screening-status">Not checked here</p>
      <p id={`project-naming-${check.icon}-guidance`}>{check.description}</p><Link className="button secondary small" href={check.href} aria-describedby={`project-naming-${check.icon}-guidance`}>Open {check.title.toLowerCase()}</Link>
    </article>)}</div>
    <p className="project-naming-muted">Choosing a name does not purchase a domain, reserve a handle or establish trademark clearance.</p>
  </section>;
}
