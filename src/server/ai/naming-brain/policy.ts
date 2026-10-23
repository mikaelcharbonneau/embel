import "server-only";
import { namingBrainPolicySchema, namingRolePolicySchema, type NamingBrainPolicy, type NamingRole, type NamingRolePolicy, type NamingStageKey } from "../../../domain/naming-brain";
import { NAMING_REFERENCE_HOSTS } from "./source-reader";

export const NAMING_GAP_PHASES = Object.freeze({ direction: { cents: 10, searches: 0 }, creation: { cents: 40, searches: 0 }, curation: { cents: 5, searches: 0 }, verification: { cents: 20, searches: 8 } });
export const NAMING_GAP_ENVELOPE = { version: 1, phases: [{ phase: "direction", cents: 10, searches: 0 }, { phase: "creation", cents: 40, searches: 0 }, { phase: "curation", cents: 5, searches: 0 }, { phase: "verification", cents: 20, searches: 8 }] } as const;
export function createNamingBrainPolicy(model: string): NamingBrainPolicy {
  return namingBrainPolicySchema.parse({ version: 1, handlerVersion: "naming-brain-v1", billingMode: "openai_api", protocol: "openai_agents", model, reasoningEffort: "xhigh",
    runAllowanceMicrousd: 5_000_000, aggregateAllowanceMicrousd: 25_000_000, maxUnsettledRuns: 5, maxConcurrentCreators: 3, maxInitialCandidates: 150, maxGapCandidates: 50, maxGapRounds: 1,
    maxInputBytes: 131_072, maxOutputBytes: 524_288, stageDeadlineMs: 240_000,
    stageLimits: { research: { maximumCostMicrousd: 750_000, maxWebSearchCalls: 4 }, direction: { maximumCostMicrousd: 250_000, maxWebSearchCalls: 0 }, creation: { maximumCostMicrousd: 1_500_000, maxWebSearchCalls: 0 }, curation: { maximumCostMicrousd: 500_000, maxWebSearchCalls: 0 }, verification: { maximumCostMicrousd: 1_250_000, maxWebSearchCalls: 20 }, gap: { maximumCostMicrousd: 750_000, maxWebSearchCalls: 8 }, prepare: { maximumCostMicrousd: 0, maxWebSearchCalls: 0 } } });
}
export function createNamingRolePolicy(policyInput: NamingBrainPolicy, stage: NamingStageKey, role: NamingRole, cents?: number, searches?: number, localPrototype = false, deadlineMs: 240000 | 900000 = 240_000): NamingRolePolicy {
  const policy = namingBrainPolicySchema.parse(policyInput), limit = policy.stageLimits[stage];
  if (!localPrototype && deadlineMs !== policy.stageDeadlineMs) throw new Error("role_timing_unavailable");
  const sessionLimitCents = cents ?? limit.maximumCostMicrousd / 10_000;
  const maxWebSearchCalls = searches ?? ((role === "researcher" || role === "verifier") ? limit.maxWebSearchCalls : 0);
  if (!localPrototype && sessionLimitCents * 10_000 > limit.maximumCostMicrousd || maxWebSearchCalls > limit.maxWebSearchCalls) throw new Error("role_allocation_exceeded");
  const research = role === "researcher" || role === "verifier";
  return namingRolePolicySchema.parse({ version: 1, role, protocol: policy.protocol, model: policy.model, reasoningEffort: policy.reasoningEffort,
    ...(localPrototype ? { budgetControl: "local_unlimited_v1" } : {}),
    maximumCostMicrousd: sessionLimitCents * 10_000, sessionLimitCents, maxWebSearchCalls, maxInputBytes: policy.maxInputBytes, maxOutputBytes: policy.maxOutputBytes, deadlineMs,
    nativeDelegation: false, allowedTools: research ? ["web_search", "read_reference"] : [], referenceHosts: research ? [...NAMING_REFERENCE_HOSTS] : [] });
}
/** The immutable v2 witness selects this profile; legacy policy rendering stays unchanged. */
export function createProgressiveNamingRolePolicy(policyInput: NamingBrainPolicy, role: NamingRole, cents?: number, searches?: number, localPrototype = false, progressiveContractVersion?: 2): NamingRolePolicy {
  if (!localPrototype) throw new Error("progressive_naming_unavailable");
  const stage: Record<NamingRole, NamingStageKey> = { researcher: "research", director: "direction", creator: "creation", curator: "curation", verifier: "verification" };
  return namingRolePolicySchema.parse({ ...createNamingRolePolicy(policyInput, stage[role], role, cents, searches, true, 900_000), localPipelineVersion: 2, ...(progressiveContractVersion ? { progressiveContractVersion } : {}) });
}
export function allocateNamingCreatorCaps(targets: readonly number[], maximumCents: number): number[] {
  if (!targets.length || targets.length > 30 || targets.some(value => !Number.isSafeInteger(value) || value < 1) || !Number.isSafeInteger(maximumCents) || maximumCents < targets.length) throw new Error("creator_allocation_invalid");
  const caps = targets.map(() => 1), total = Math.min(maximumCents, targets.reduce((sum, value) => sum + value, 0));
  for (let assigned = caps.length; assigned < total;) for (let index = 0; index < targets.length && assigned < total; index++) if (caps[index]! < targets[index]!) { caps[index] = caps[index]! + 1; assigned++; }
  return caps;
}
