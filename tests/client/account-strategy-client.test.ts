import { afterEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { strategyJobSchema, strategyOverviewResponseSchema, type StrategyJob } from "@/domain/strategy-jobs";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import {
  canContinueStrategy,
  forgetStrategyIntent,
  promptStrategyPlan,
  readStrategyIntent,
  rememberStrategyIntent,
  rememberStrategyPlan,
  strategyIntentPlan,
  strategyAvailabilityMessage,
  strategyJobMatchesRequest,
  strategyResultApplication,
  verifyStrategyJobs,
} from "@/components/workspace/account-strategy-client";

const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const when = "2026-10-03T10:00:00Z";
const project = accountProjectSchema.parse({
  id: projectId,
  owner_id: owner,
  title: "Local strategy fixture",
  scope: "complete_brand",
  current_revision: 3,
  created_at: when,
  context: { description: "A neighborhood kitchen" },
});
function job() {
  const parsed = strategyJobSchema.parse({
    id: "cccccccc-1111-4111-8111-111111111111",
    owner_id: owner,
    project_id: projectId,
    operation: "strategy.reformulate",
    input_revision: 3,
    state: "succeeded",
    progress: 100,
    reserved_cost_microusd: 100000,
    actual_cost_microusd: 2000,
    error_code: null,
    cancel_requested_at: null,
    created_at: when,
    finished_at: when,
    results: [
      {
        stepKey: "response",
        output: {
          version: 1,
          provider: "openai",
          operation: "strategy.reformulate",
          model: "fixture-model",
          responseId: "fixture-response",
          requestId: null,
          generatedAt: when,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 },
          proposal: {
            message: "Fixture response",
            activity: "Kitchen",
            offering: "Lunch",
            knownAudience: "Neighbors",
            questions: [],
          },
        },
      },
    ],
  });
  return parsed;
}
const availability = {
  status: "available" as const,
  operations: [{ operation: "strategy.competitors" as const, maximumCostMicrousd: 2000000 }],
};
const intent = { ownerId: owner, projectId, revision: 3, reformulationCap: 100000, competitorsCap: 2000000 };
const workspace = {
  ownerId: owner,
  generation: 1,
  saved: project,
  draft: accountProjectDraft(project),
  conflict: false,
};
const appliedProject = {
  ...project,
  current_revision: 4,
  context: { ...project.context, activity: "Kitchen", offering: "Lunch", knownAudience: "Neighbors" },
};
const appliedWorkspace = { ...workspace, saved: appliedProject, draft: accountProjectDraft(appliedProject) };
function appliedJob(input: StrategyJob = job()): StrategyJob {
  return {
    ...input,
    results: input.results.map((result) => ({
      ...result,
      application: {
        jobId: input.id,
        stepKey: result.stepKey,
        inputRevision: input.input_revision,
        appliedRevision: input.input_revision + 1,
        appliedAt: when,
      },
    })),
  };
}

afterEach(() => vi.unstubAllGlobals());
describe("account strategy availability messages", () => {
  it("describes unavailable account allowance after an applied response without claiming a provider outage or trial exhaustion", () => {
    const overview = strategyOverviewResponseSchema.parse({
      availability: { status: "unavailable", operations: [], reason: "budget_unavailable" },
      jobs: [appliedJob()],
    });
    const message = strategyAvailabilityMessage(overview.availability, "project");
    expect(message).toBe("No AI requests are available for this account. You can still edit and save your project.");
    expect(message).not.toMatch(/OpenAI|trial|exhausted|No AI request was sent/i);
  });
  it.each([
    ["runtime_disabled", "AI is not enabled in this workspace."],
    ["worker_unavailable", "AI replies are unavailable right now."],
    ["quota_unavailable", "The current AI request limit is unavailable."],
    [
      "request_unresolved",
      "A previous request needs review before another can start. Check its status before trying again.",
    ],
    ["request_active", "A request is already in progress. Wait for it to finish, then check status."],
  ] as const)("retains the verified %s reason without making claims about earlier requests", (reason, expected) => {
    const overview = strategyOverviewResponseSchema.parse({
      availability: { status: "unavailable", operations: [], reason },
      jobs: [],
    });
    const message = strategyAvailabilityMessage(overview.availability, "project");
    expect(message).toContain(expected);
    expect(message).toContain("You can still edit and save your project.");
    expect(message).not.toContain("No AI request was sent");
  });
  it("keeps an unconfirmed read distinct from an allowance refusal and directs recovery before retrying", () => {
    const message = strategyAvailabilityMessage(null, "project");
    expect(message).toContain("AI availability could not be confirmed.");
    expect(message).toContain("Check existing request status before trying again.");
    expect(message).not.toMatch(/No AI requests are available|No AI request was sent|OpenAI is unavailable/);
  });
  it("describes an unsupported response plan without treating other ready operations as a provider outage", () => {
    expect(promptStrategyPlan(availability)).toBeNull();
    expect(strategyAvailabilityMessage(availability, "project")).toBe(
      "AI replies are not enabled for this step. You can still edit and save your project.",
    );
  });
  it("preserves prompt retention and no-send context for Home callers that stop before admission", () => {
    expect(strategyAvailabilityMessage({ status: "unavailable", operations: [], reason: "budget_unavailable" })).toBe(
      "No AI requests are available for this account. No AI request was sent. Your prompt is kept.",
    );
    expect(strategyAvailabilityMessage({ status: "unavailable", operations: [], reason: "worker_unavailable" })).toBe(
      "The AI worker is not ready. Recheck after it is connected. No AI request was sent. Your prompt is kept.",
    );
    expect(strategyAvailabilityMessage(null)).toBe(
      "AI availability could not be confirmed. Recheck before sending. Your prompt is kept.",
    );
  });
});

describe("account strategy admission", () => {
  it("rejects a mixed-owner or mixed-project overview before any output is displayed", () => {
    const valid = strategyOverviewResponseSchema.parse({ availability, jobs: [job()] });
    expect(verifyStrategyJobs(valid.jobs, owner, projectId)).toBe(true);
    expect(verifyStrategyJobs([{ ...job(), owner_id: projectId }], owner, projectId)).toBe(false);
    expect(verifyStrategyJobs([{ ...job(), project_id: owner }], owner, projectId)).toBe(false);
  });
  it("accepts initial and follow-up queue replies only for the requested operation, revision and cap", () => {
    expect(strategyJobMatchesRequest(job(), "strategy.reformulate", 3, 100000)).toBe(true);
    expect(strategyJobMatchesRequest(job(), "strategy.reformulate", 3, 99999)).toBe(false);
    expect(strategyJobMatchesRequest(job(), "strategy.reformulate", 4, 100000)).toBe(false);
    expect(strategyJobMatchesRequest(job(), "strategy.competitors", 3, 100000)).toBe(false);
  });
  it("requires explicit acceptance before the initial response can start competitor research", () => {
    const overview = strategyOverviewResponseSchema.parse({ availability, jobs: [job()] });
    expect(canContinueStrategy(intent, workspace, overview)).toBe(false);
    expect(canContinueStrategy(intent, appliedWorkspace, overview)).toBe(false);
  });
  it("continues accepted research only on the exact new version created by applying the response", () => {
    const overview = strategyOverviewResponseSchema.parse({ availability, jobs: [appliedJob()] });
    expect(canContinueStrategy(intent, appliedWorkspace, overview)).toBe(true);
    expect(canContinueStrategy(intent, workspace, overview)).toBe(false);
    expect(canContinueStrategy(null, appliedWorkspace, overview)).toBe(false);
    expect(canContinueStrategy({ ...intent, ownerId: projectId }, appliedWorkspace, overview)).toBe(false);
    expect(
      canContinueStrategy(
        intent,
        { ...appliedWorkspace, draft: { ...appliedWorkspace.draft, description: "An unsaved correction" } },
        overview,
      ),
    ).toBe(false);
    expect(canContinueStrategy(intent, { ...appliedWorkspace, conflict: true }, overview)).toBe(false);
    const laterProject = { ...appliedProject, current_revision: 5 };
    expect(
      canContinueStrategy(
        intent,
        { ...appliedWorkspace, saved: laterProject, draft: accountProjectDraft(laterProject) },
        overview,
      ),
    ).toBe(false);
    expect(
      canContinueStrategy(intent, appliedWorkspace, { ...overview, jobs: [{ ...appliedJob(), state: "running" }] }),
    ).toBe(false);
    expect(
      canContinueStrategy(intent, appliedWorkspace, { ...overview, jobs: [{ ...appliedJob(), results: [] }] }),
    ).toBe(false);
    expect(
      canContinueStrategy(intent, appliedWorkspace, {
        ...overview,
        jobs: [{ ...appliedJob(), cancel_requested_at: when }],
      }),
    ).toBe(false);
  });
  it("does not confuse an older competitor request with one on the accepted response version", () => {
    const competitor = {
      ...job(),
      operation: "strategy.competitors" as const,
      state: "cancelled" as const,
      results: [],
    };
    const overview = strategyOverviewResponseSchema.parse({ availability, jobs: [appliedJob(), competitor] });
    expect(canContinueStrategy(intent, appliedWorkspace, overview)).toBe(true);
    expect(
      canContinueStrategy(intent, appliedWorkspace, {
        ...overview,
        jobs: [appliedJob(), { ...competitor, input_revision: 4 }],
      }),
    ).toBe(false);
  });
  it("requires the exact job, result step and revision in an application receipt", () => {
    const accepted = appliedJob();
    const result = accepted.results[0]!;
    for (const patch of [{ jobId: projectId }, { stepKey: "other" }, { inputRevision: 2 }, { appliedRevision: 5 }]) {
      const changed = { ...accepted, results: [{ ...result, application: { ...result.application!, ...patch } }] };
      expect(strategyResultApplication(changed, result.stepKey)).toBeNull();
      expect(canContinueStrategy(intent, appliedWorkspace, { availability, jobs: [changed] })).toBe(false);
    }
    expect(strategyResultApplication(accepted, result.stepKey)?.appliedRevision).toBe(4);
    expect(strategyResultApplication(accepted, "other")).toBeNull();
  });
  it("does not silently accept an increased cost or unavailable worker", () => {
    const overview = strategyOverviewResponseSchema.parse({ availability, jobs: [appliedJob()] });
    expect(canContinueStrategy({ ...intent, competitorsCap: 1000000 }, appliedWorkspace, overview)).toBe(false);
    expect(
      canContinueStrategy(intent, appliedWorkspace, {
        ...overview,
        availability: { status: "unavailable", reason: "worker_unavailable", operations: [] },
      }),
    ).toBe(false);
    expect(
      canContinueStrategy(intent, appliedWorkspace, {
        ...overview,
        jobs: [{ ...job(), reserved_cost_microusd: intent.reformulationCap + 1, results: appliedJob().results }],
      }),
    ).toBe(false);
  });
  it("persists only scoped cost consent and prevents reuse by another account or revision", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const scoped = { ...intent, revision: 11 };
    rememberStrategyIntent(scoped);
    expect(readStrategyIntent(owner, projectId, 11)).toEqual(scoped);
    expect(readStrategyIntent(projectId, projectId, 11)).toBeNull();
    expect(readStrategyIntent(owner, projectId, 12)).toBeNull();
    expect(JSON.parse([...values.values()][0]!)).toEqual([scoped]);
  });
  it("cancellation revokes continuation even if session storage cannot be updated", () => {
    const values = new Map<string, string>();
    let locked = false;
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (locked) throw new Error("Synthetic storage failure");
          values.set(key, value);
        },
      },
    });
    const scoped = { ...intent, revision: 13 };
    rememberStrategyIntent(scoped);
    locked = true;
    forgetStrategyIntent(owner, projectId, 13);
    expect(readStrategyIntent(owner, projectId, 13)).toBeNull();
  });
});

describe("response-only API consent", () => {
  const responseAvailability = {
    status: "available" as const,
    operations: [{ operation: "strategy.reformulate" as const, maximumCostMicrousd: 122880 }],
  };
  it("offers one explicitly response-only plan when API research is unavailable", () => {
    expect(promptStrategyPlan(responseAvailability)).toEqual({
      kind: "response_only",
      billingMode: "openai_api",
      reformulation: { billingMode: "openai_api", maximumCostMicrousd: 122880 },
    });
    expect(
      promptStrategyPlan({
        status: "available",
        operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 100000 }],
      }),
    ).toBeNull();
  });
  it("stores no research allowance and never continues after acceptance or later readiness", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const plan = promptStrategyPlan(responseAvailability);
    expect(plan).not.toBeNull();
    rememberStrategyPlan({ ownerId: owner, projectId, revision: 3 }, plan!);
    const saved = readStrategyIntent(owner, projectId, 3);
    expect(saved).toEqual({
      ownerId: owner,
      projectId,
      revision: 3,
      kind: "response_only",
      billingMode: "openai_api",
      reformulationCap: 122880,
    });
    expect(strategyIntentPlan(saved!)).not.toHaveProperty("competitors");
    const overview = strategyOverviewResponseSchema.parse({ availability, jobs: [appliedJob()] });
    expect(canContinueStrategy(saved, appliedWorkspace, overview)).toBe(false);
    vi.resetModules();
    const reopened = await import("@/components/workspace/account-strategy-client");
    const restored = reopened.readStrategyIntent(owner, projectId, 3);
    expect(restored).toEqual(saved);
    expect(reopened.canContinueStrategy(restored, appliedWorkspace, overview)).toBe(false);
    expect(
      reopened.canContinueStrategy(restored, appliedWorkspace, { ...overview, availability: responseAvailability }),
    ).toBe(false);
    expect(reopened.readStrategyIntent(projectId, projectId, 3)).toBeNull();
  });
  it("rejects a stored response-only intent containing a filled-in research allowance", () => {
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: () =>
          JSON.stringify([
            {
              ownerId: owner,
              projectId,
              revision: 97,
              billingMode: "openai_api",
              kind: "response_only",
              reformulationCap: 122880,
              competitorsCap: 3142880,
            },
          ]),
      },
    });
    expect(readStrategyIntent(owner, projectId, 97)).toBeNull();
  });
});
