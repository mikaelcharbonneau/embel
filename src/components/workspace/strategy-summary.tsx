"use client";

import { useId } from "react";
import { Icon } from "@/components/ui/icon";
import type { ContextSnapshot } from "@/domain/projects";
import { CompetitorLogo } from "./competitor-logo";

/** Strategy, once complete: the saved competitors, audience and positioning in
 * one card. Edit strategy shows the individual answers, each with its own Edit. */
export function StrategySummary({ projectId, context, angle, expanded, onToggle }: {
  projectId: string; context: ContextSnapshot; angle: string | null; expanded: boolean; onToggle: () => void;
}) {
  const id = useId();
  const competitors = context.competitors.filter(item => item.selected);
  const audience = context.audienceSegments.filter(item => item.selected);
  return <section className="strategy-summary flow-enter" aria-labelledby={`${id}-title`}>
    <div className="strategy-summary-head">
      <span className="strategy-summary-mark" aria-hidden="true"><Icon name="check" size={12} /></span>
      <h2 id={`${id}-title`}>Strategy</h2>
      <span className="strategy-summary-state">Complete</span>
      <button type="button" className="button secondary small" aria-expanded={expanded} onClick={onToggle}>{expanded ? "Hide answers" : "Edit strategy"}</button>
    </div>
    <dl>
      <div>
        <dt>Competitors</dt>
        <dd className="strategy-summary-chips">{competitors.length ? competitors.map(item => <span key={item.id} className="strategy-summary-chip">
          <CompetitorLogo projectId={projectId} name={item.name} url={item.url} size={22} />{item.name}
        </span>) : <span>None kept</span>}</dd>
      </div>
      <div>
        <dt>Audience</dt>
        <dd>{audience.map(item => item.label).join(" · ") || "Not chosen"}</dd>
      </div>
      <div>
        <dt>Positioning</dt>
        <dd className="strategy-summary-positioning">{angle && <strong>{angle}</strong>}<span>{context.positioning}</span></dd>
      </div>
    </dl>
  </section>;
}
