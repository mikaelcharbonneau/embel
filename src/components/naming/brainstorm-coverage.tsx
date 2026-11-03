import { ContextDetails } from "@/components/ui/context-details";
import { NAMING_APPROACHES, type NamingApproach } from "@/domain/naming-brain-preferences";
import type { NamingBrainRunSummary, NamingFeedEntry } from "@/domain/naming-brain";
import type { NamingPreferenceRevision } from "@/domain/project-naming";
import styles from "./naming-chat.module.css";

export function suggestedApproachLabel(approach: NamingApproach) {
  return NAMING_APPROACHES.find(option => option.id === approach)!.label;
}

type Props = {
  run?: NamingBrainRunSummary | null;
  saved?: NamingPreferenceRevision | null;
  entries: readonly NamingFeedEntry[];
};

export function BrainstormCoverage({ run, saved, entries }: Props) {
  const count = run?.fulfillment?.acceptedCount;
  if (run?.generationProfile !== "brainstorm_v1" || !count || !saved || saved.preferences.version !== 2 ||
      saved.ownerId !== run.ownerId || saved.projectId !== run.projectId || saved.version !== run.preferencesVersion) return null;

  const routes = saved.preferences.approaches;
  const counts = new Map(routes.map(route => [route, 0]));
  const seen = new Set<string>();
  // A page may include earlier runs or only part of this run. An unloaded route is never a zero.
  for (const row of entries) {
    if (row.runId !== run.runId) continue;
    const candidate = row.entry.candidate, origin = candidate.origin, route = row.primaryApproach;
    if (origin.kind !== "brainstorm" || origin.batchId !== run.batchId || origin.runId !== run.runId ||
        origin.jobId !== run.jobId || candidate.ownerId !== run.ownerId || candidate.projectId !== run.projectId ||
        !route || !counts.has(route) || seen.has(candidate.id)) return null;
    counts.set(route, counts.get(route)! + 1);
    seen.add(candidate.id);
  }
  if (seen.size !== count) return null;

  const represented = [...counts.values()].filter(total => total > 0).length;
  return <ContextDetails className={styles.coverage} title={`Latest brainstorm · ${represented} of ${routes.length} approaches represented`}>
    <p>{count} saved {count === 1 ? "name" : "names"} in this batch. Each is counted once under its suggested approach. {!run.fulfillment?.coverageSatisfied && " The coverage target is at least five names per requested approach."}</p>
    <table><caption>Requested approaches in this batch</caption>
      <thead><tr><th scope="col">Suggested approach</th><th scope="col">Saved names</th></tr></thead>
      <tbody>{routes.map(route => <tr key={route}><th scope="row">{suggestedApproachLabel(route)}</th><td>{counts.get(route)}</td></tr>)}</tbody>
    </table>
  </ContextDetails>;
}
