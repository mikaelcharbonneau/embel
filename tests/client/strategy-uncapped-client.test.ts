// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { strategyRuntimeResponseSchema, type StrategyJob } from "@/domain/strategy-jobs";
import {
  isUncappedStrategyAllowance,
  promptStrategyPlan,
  rememberStrategyPlan,
  readStrategyIntent,
  strategyIntentPlan,
  strategyAllowanceWithin,
  strategyJobMatchesRequest,
} from "@/components/workspace/account-strategy-client";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const response = "a".repeat(64),
  competitors = "b".repeat(64);
const available = () =>
  strategyRuntimeResponseSchema.parse({
    availability: {
      status: "available",
      operations: [
        {
          operation: "strategy.reformulate",
          billingMode: "openai_api",
          spendControl: "uncapped",
          policyIdentity: response,
          interviewVersion: 1,
        },
        {
          operation: "strategy.competitors",
          billingMode: "openai_api",
          spendControl: "uncapped",
          policyIdentity: competitors,
          interviewVersion: 1,
        },
      ],
    },
  }).availability;
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

it("offers the engine's uncapped policy consent without a monetary field", () => {
  const plan = promptStrategyPlan(available())!;
  expect(isUncappedStrategyAllowance(plan.reformulation)).toBe(true);
  expect(plan.reformulation).toEqual({ billingMode: "openai_api", spendControl: "uncapped", policyIdentity: response });
});

it("retains the exact two-operation policy consent across browser storage reads", () => {
  const plan = promptStrategyPlan(available())!;
  rememberStrategyPlan({ ownerId: owner, projectId: project, revision: 3 }, plan);
  const intent = readStrategyIntent(owner, project, 3)!;
  expect(strategyIntentPlan(intent)).toEqual(plan);
  expect(intent).not.toHaveProperty("reformulationCap");
  expect(intent).not.toHaveProperty("competitorsCap");
  expect(readStrategyIntent(project, project, 3)).toBeNull();
});

it("rejects changed policies, bounded consent and forged mixed request plans", () => {
  const plan = promptStrategyPlan(available())!,
    accepted = plan.reformulation;
  expect(
    strategyAllowanceWithin(
      { billingMode: "openai_api", spendControl: "uncapped", policyIdentity: competitors },
      accepted,
    ),
  ).toBe(false);
  expect(strategyAllowanceWithin({ billingMode: "openai_api", maximumCostMicrousd: 10 }, accepted)).toBe(false);
  expect(strategyAllowanceWithin(accepted, { billingMode: "openai_api", maximumCostMicrousd: 10 })).toBe(false);
  expect(
    promptStrategyPlan({
      status: "available",
      operations: [
        available().operations[0]!,
        { operation: "strategy.competitors", maximumCostMicrousd: 10, interviewVersion: 1 },
      ],
    }),
  ).toBeNull();
  const job = {
    operation: "strategy.reformulate",
    input_revision: 3,
    billingMode: "openai_api",
    spendControl: "uncapped",
    policyIdentity: response,
    reserved_cost_microusd: 0,
  } as StrategyJob;
  expect(strategyJobMatchesRequest(job, "strategy.reformulate", 3, accepted)).toBe(true);
  expect(strategyJobMatchesRequest({ ...job, policyIdentity: competitors }, "strategy.reformulate", 3, accepted)).toBe(
    false,
  );
  expect(strategyJobMatchesRequest(job, "strategy.reformulate", 3, 100)).toBe(false);
});
