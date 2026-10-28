// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { strategyRuntimeResponseSchema, type StrategyJob } from "@/domain/strategy-jobs";
import { isUncappedStrategyAllowance, promptStrategyPlan, rememberStrategyPlan, readStrategyIntent, strategyIntentPlan, strategyRequestPayload, strategyAllowanceLabel, strategyAllowanceWithin, strategyJobMatchesRequest, strategyPromptCost } from "@/components/workspace/account-strategy-client";
import { rememberGuidedStartConsent, markGuidedStartAttempt, readGuidedStartConsent } from "@/components/workspace/guided-start-consent";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const response = "a".repeat(64), competitors = "b".repeat(64);
const available = () => strategyRuntimeResponseSchema.parse({ availability: { status: "available", operations: [
  { operation: "strategy.reformulate", billingMode: "openai_api", spendControl: "uncapped", policyIdentity: response, interviewVersion: 1 },
  { operation: "strategy.competitors", billingMode: "openai_api", spendControl: "uncapped", policyIdentity: competitors, interviewVersion: 1 },
] } }).availability;
beforeEach(() => { window.sessionStorage.clear(); window.localStorage.clear(); });

it("uses future policy consent and idempotency without a monetary field; legacy bodies stay exact", () => {
  const plan = promptStrategyPlan(available())!;
  expect(isUncappedStrategyAllowance(plan.reformulation)).toBe(true); expect(strategyPromptCost(plan)).toBeNull();
  expect(strategyAllowanceLabel(plan.reformulation)).toBe("OpenAI API usage");
  expect(strategyRequestPayload(project, 3, "strategy.reformulate", plan.reformulation)).toEqual({ operation: "strategy.reformulate", expectedRevision: 3,
    idempotencyKey: `strategy.managed.v3:${project}:3:strategy.reformulate`, billingMode: "openai_api", spendControl: "uncapped", acceptedPolicyIdentity: response });
  expect(strategyRequestPayload(project, 3, "strategy.reformulate", { billingMode: "openai_api", maximumCostMicrousd: 100 })).toEqual({
    operation: "strategy.reformulate", expectedRevision: 3, idempotencyKey: `strategy.v1:${project}:3:strategy.reformulate`, acceptedMaxCostMicrousd: 100 });
});

it("retains the exact two-operation policy consent across browser storage reads", () => {
  const plan = promptStrategyPlan(available())!;
  rememberStrategyPlan({ ownerId: owner, projectId: project, revision: 3 }, plan);
  const intent = readStrategyIntent(owner, project, 3)!;
  expect(strategyIntentPlan(intent)).toEqual(plan);
  expect(intent).not.toHaveProperty("reformulationCap"); expect(intent).not.toHaveProperty("competitorsCap");
  expect(readStrategyIntent(project, project, 3)).toBeNull();
});

it("rejects changed policies, bounded consent and forged mixed request plans", () => {
  const plan = promptStrategyPlan(available())!, accepted = plan.reformulation;
  expect(strategyAllowanceWithin({ billingMode: "openai_api", spendControl: "uncapped", policyIdentity: competitors }, accepted)).toBe(false);
  expect(strategyAllowanceWithin({ billingMode: "openai_api", maximumCostMicrousd: 10 }, accepted)).toBe(false);
  expect(strategyAllowanceWithin(accepted, { billingMode: "openai_api", maximumCostMicrousd: 10 })).toBe(false);
  expect(promptStrategyPlan({ status: "available", operations: [available().operations[0]!, { operation: "strategy.competitors", maximumCostMicrousd: 10, interviewVersion: 1 }] })).toBeNull();
  const job = { operation: "strategy.reformulate", input_revision: 3, billingMode: "openai_api", spendControl: "uncapped", policyIdentity: response, reserved_cost_microusd: 0 } as StrategyJob;
  expect(strategyJobMatchesRequest(job, "strategy.reformulate", 3, accepted)).toBe(true);
  expect(strategyJobMatchesRequest({ ...job, policyIdentity: competitors }, "strategy.reformulate", 3, accepted)).toBe(false);
  expect(strategyJobMatchesRequest(job, "strategy.reformulate", 3, 100)).toBe(false);
});

it("never upgrades or changes an attempted guided request's saved consent", () => {
  const allowance = { billingMode: "openai_api" as const, spendControl: "uncapped" as const, policyIdentity: competitors }, turn = "guided-start-v1:uncapped-fixture";
  expect(rememberGuidedStartConsent(owner, turn, allowance)).toBe(true); expect(markGuidedStartAttempt(owner, turn)).toBe(true);
  expect(rememberGuidedStartConsent(owner, turn, { ...allowance, policyIdentity: response })).toBe(false);
  expect(rememberGuidedStartConsent(owner, turn, { billingMode: "openai_api", maximumCostMicrousd: 0 })).toBe(false);
  expect(readGuidedStartConsent(owner, turn)?.allowance).toEqual(allowance);
  const old = "guided-start-v1:bounded-fixture";
  rememberGuidedStartConsent(owner, old, { billingMode: "openai_api", maximumCostMicrousd: 100 }); markGuidedStartAttempt(owner, old);
  expect(rememberGuidedStartConsent(owner, old, allowance)).toBe(false);
});
