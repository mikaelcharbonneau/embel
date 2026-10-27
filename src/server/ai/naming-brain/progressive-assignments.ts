import "server-only";
import { namingBriefSnapshotSchema, namingProgressiveAssignmentSchema, type NamingAssignmentPlan, type NamingBriefSnapshot, type NamingProgressiveAssignment, type NamingResearchPack } from "../../../domain/naming-brain";
import type { NamingApproach } from "../../../domain/naming-brain-preferences";

export const PROGRESSIVE_CREATIVE_APPROACHES: ReadonlySet<NamingApproach> = new Set(["real_words", "compounds", "blends", "invented", "modified", "phrases", "initials"]);
export const PROGRESSIVE_PART_LIMIT = 40;
export const PROGRESSIVE_RAW_LIMIT = 200;
export const progressivePartKey = (index: number) => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= PROGRESSIVE_PART_LIMIT) throw new Error("progressive_part_limit");
  return `part${String(index + 1).padStart(3, "0")}`;
};

const territories = [
  ["objects", "Unexpected animals, plants, fruit, materials and ordinary objects can suggest a memorable metaphor. A loose category connection is welcome."],
  ["rituals", "Explore small everyday rituals, gestures and moments associated with the desired experience, without literal industry vocabulary."],
  ["movement", "Explore movement, pace, rhythm and contrasts in energy. Vary the sound and structure rather than repeating a liked name's ending."],
  ["senses", "Explore texture, light, weather, shape and sensory contrasts. Keep the association imaginative and the explanation simple."],
  ["outcomes", "Explore the experience or change the brand makes possible through indirect imagery, not a descriptive product label."],
  ["other-worlds", "Borrow unexpected creative associations from another everyday world. Do not invent a historical origin or require an elaborate story."],
] as const;

/** Pure application assignments are labeled as such; they are never fake AI plans. */
export function createProgressiveNamingAssignment(options: {
  runId: string; snapshot: NamingBriefSnapshot; partIndex: number; approach: NamingApproach; targetCount: number;
  research?: NamingResearchPack; guidance?: NamingAssignmentPlan; generatedValues?: readonly string[];
}): NamingProgressiveAssignment {
  const snapshot = namingBriefSnapshotSchema.parse(options.snapshot), key = progressivePartKey(options.partIndex);
  if (!snapshot.preferences.approaches.includes(options.approach) || !Number.isSafeInteger(options.targetCount) || options.targetCount < 1 || options.targetCount > 6) throw new Error("progressive_assignment_invalid");
  const guidance = options.guidance, research = options.research;
  if (guidance && (guidance.runId !== options.runId || guidance.snapshotHash !== snapshot.snapshotHash || guidance.providerReceipt.localPipelineVersion !== 2)) throw new Error("progressive_guidance_mismatch");
  if (research && (research.runId !== options.runId || research.snapshotHash !== snapshot.snapshotHash || research.providerReceipt.localPipelineVersion !== 2)) throw new Error("progressive_research_mismatch");
  if (guidance && "planVersion" in guidance.output && guidance.output.unavailableApproaches.some(row => row.approach === options.approach)) throw new Error("progressive_approach_unavailable");
  const routeIndex = snapshot.preferences.approaches.indexOf(options.approach);
  const variation = Math.floor(options.partIndex / snapshot.preferences.approaches.length);
  const sourceMap = new Map(research?.sources.map(source => [source.sourceKey, source]) ?? []);
  // An unusable factual direction must not hide a genuinely sourced sibling.
  // The retained Director artifact is untouched; only eligible templates are
  // selected for a new, separately frozen application assignment.
  const templates = guidance?.output.assignments.filter(row => row.primaryApproach === options.approach
    && (PROGRESSIVE_CREATIVE_APPROACHES.has(options.approach)
      || row.sourceKeys.length > 0 && row.sourceKeys.every(key => sourceMap.get(key)?.evidenceStatus === "retrieved"))) ?? [];
  const template = templates.length ? templates[variation % templates.length] : undefined;
  // These are literal identities from retained outputs, never a prohibition on
  // related roots, sounds or imagery. Bound the tail so request size stays finite.
  const exactValues = [...new Set(options.generatedValues ?? [])].slice(-100);
  const literalExclusions: string[] = [];
  for (const value of exactValues) {
    const literal = JSON.stringify(value), last = literalExclusions.at(-1);
    if (last && last.length + literal.length + 2 <= 1900) literalExclusions[literalExclusions.length - 1] = `${last}, ${literal}`;
    else literalExclusions.push(`Do not repeat these exact already generated values; related imagery remains welcome: ${literal}`);
  }
  const avoidPatterns = (patterns: readonly string[]) => [...literalExclusions, ...patterns.slice(0, Math.max(0, 20 - literalExclusions.length))];
  if (!PROGRESSIVE_CREATIVE_APPROACHES.has(options.approach) && (!template || !template.sourceKeys.length || template.sourceKeys.some(sourceKey => sourceMap.get(sourceKey)?.evidenceStatus !== "retrieved"))) throw new Error("progressive_factual_context_required");
  if (template) {
    if (!research || template.sourceKeys.some(sourceKey => !sourceMap.has(sourceKey))) throw new Error("progressive_guidance_source_missing");
    return namingProgressiveAssignmentSchema.parse({ ...template, assignmentKey: `${key}-${options.approach}`, runId: options.runId, snapshotHash: snapshot.snapshotHash,
      assignmentOrder: options.partIndex, round: "initial", targetCount: options.targetCount, sources: template.sourceKeys.map(sourceKey => sourceMap.get(sourceKey)!), avoidPatterns: avoidPatterns(template.avoidPatterns),
      assignmentBasis: { kind: "director_guidance", artifactId: guidance!.artifactId, runId: guidance!.runId, snapshotHash: guidance!.snapshotHash } });
  }
  if (!PROGRESSIVE_CREATIVE_APPROACHES.has(options.approach)) throw new Error("progressive_factual_context_required");
  const territory = territories[(variation + routeIndex) % territories.length]!;
  return namingProgressiveAssignmentSchema.parse({ assignmentKey: `${key}-${options.approach}`, primaryApproach: options.approach, additionalApproaches: [],
    territoryId: `brief-${territory[0]}`, constructionKey: `brief-${options.approach}-${variation % 3}`, direction: territory[1], targetCount: options.targetCount,
    sourceKeys: [], avoidPatterns: avoidPatterns(snapshot.patternSummaries.slice(0, 20).map(row => `Vary this existing pattern rather than excluding all related names: ${row.pattern}`)), freshTerritory: true,
    runId: options.runId, snapshotHash: snapshot.snapshotHash, assignmentOrder: options.partIndex, round: "initial", sources: [],
    assignmentBasis: { kind: "brief_seed", snapshotHash: snapshot.snapshotHash } });
}

/** Include active targets so three concurrent parts do not all choose one route. */
export function chooseProgressiveNamingApproach(snapshot: NamingBriefSnapshot, counts: readonly { approach: NamingApproach; count: number }[], inFlight: readonly Pick<NamingProgressiveAssignment, "primaryApproach" | "targetCount">[], available: ReadonlySet<NamingApproach>, guidance?: NamingAssignmentPlan): NamingApproach | null {
  const selected = snapshot.preferences.approaches;
  if (guidance && (guidance.snapshotHash !== snapshot.snapshotHash || guidance.providerReceipt.localPipelineVersion !== 2)) throw new Error("progressive_guidance_mismatch");
  const rawWeights = new Map(selected.map(approach => [approach, guidance?.output.assignments.filter(row => row.primaryApproach === approach).reduce((sum, row) => sum + row.targetCount, 0) ?? 0]));
  const totalWeight = [...rawWeights.values()].reduce((sum, count) => sum + count, 0);
  // Five primary credits are the hard floor. The real Director's allocation
  // steers the remaining exploration softly; it is not an equal-mix mandate.
  const targets = new Map(selected.map(approach => [approach, totalWeight > 0 ? 5 + (100 - 5 * selected.length) * rawWeights.get(approach)! / totalWeight : Math.ceil(100 / selected.length)]));
  const effective = new Map(selected.map(approach => [approach, (counts.find(row => row.approach === approach)?.count ?? 0) + inFlight.filter(row => row.primaryApproach === approach).reduce((sum, row) => sum + row.targetCount, 0)]));
  const eligible = selected.filter(approach => available.has(approach) && effective.get(approach)! < targets.get(approach)!);
  const deficit = (approach: NamingApproach) => (targets.get(approach)! - effective.get(approach)!) / targets.get(approach)!;
  eligible.sort((a, b) => deficit(b) - deficit(a) || selected.indexOf(a) - selected.indexOf(b));
  return eligible[0] ?? null;
}
