import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const started = vi.hoisted(() => ({ runs: [] as string[], fail: false }));
vi.mock("../../src/server/engine/start", () => ({
  startAdmittedRun: vi.fn(async (_kind: string, runId: string) => {
    if (started.fail) throw new Error("workflow_start_failed");
    started.runs.push(runId);
  }),
}));
import type { AuthenticatedContext } from "../../src/server/auth/context";
import {
  cancelIdentityBatch,
  closeIdentityBatchRequest,
  enqueueIdentityBatch,
  getIdentityAvailability,
  getIdentityBatch,
  IdentityAdmissionUncertainError,
} from "../../src/server/data/identity-jobs";
import { identityRunNeedsStart } from "../../src/server/engine/identity";
import { ENGINE_IDENTITY_POLICY_IDENTITY } from "../../src/server/engine/identity-input";
import {
  batchId,
  batchState as legacyBatchState,
  generationIntent as legacyIntent,
  id,
  ownerId,
  projectId,
  selectedLogoJobInput,
} from "../fixtures/identity-generation";

// Creative directions' switch between the shared worker and the generation engine,
// with mocked database calls only. The kind's enabled flag is the switch.
const frozen = selectedLogoJobInput(Uint8Array.of(1, 2, 3));
if (frozen.version !== 3) throw Error("Expected the selected-logo fixture");
const sourceLogo = frozen.sourceLogo;
const intent = {
  ...legacyIntent,
  version: 3 as const,
  sourceLogo: sourceLogo.source,
  expectedLogoRevision: sourceLogo.selectionRevision,
  expectedReferenceRevision: 0,
  acceptedPolicyIdentity: ENGINE_IDENTITY_POLICY_IDENTITY,
};
const batch = (status = "running") => ({
  ...legacyBatchState(),
  status,
  intent,
  input: frozen.input,
  sourceLogo,
  sourceLogoCurrent: true,
  usage: { status: "pending" as const, knownCostMicrousd: 0 },
});
const available = {
  version: 3,
  sourceLogo,
  expectedLogoRevision: 1,
  expectedProjectRevision: 1,
  expectedReferenceRevision: 0,
  expectedPreferencesRevision: 0,
  expectedIdentityRevision: 0,
  estimatedCostMicrousd: null,
  spendControl: "uncapped",
  ownerId,
  projectId,
  status: "available",
  operation: "identity.image",
  requestedModel: "gpt-image-2.6-sunburst",
  policyIdentity: ENGINE_IDENTITY_POLICY_IDENTITY,
  handlerVersion: "identity-image-v1",
  targetCount: 3,
  maxReferenceImages: 4,
  maxReferenceBytes: 20971520,
};
const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: id(70),
  owner_id: ownerId,
  project_id: projectId,
  kind: "identity.directions",
  status: "queued",
  workflow_run_id: null,
  created_at: new Date().toISOString(),
  input: { version: 1, revision: 1, batchId, jobId: id(3) },
  ...overrides,
});

function fixture(options: {
  enabled: boolean;
  runs?: unknown[];
  answers?: Record<string, { data?: unknown; error?: unknown }>;
}) {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    if (name === "get_generation_catalog")
      return { data: { kinds: [{ kind: "identity.directions", enabled: options.enabled }] }, error: null };
    const answer = options.answers?.[name];
    return { data: answer?.data ?? null, error: answer?.error ?? null };
  });
  const filters: [string, unknown][] = [];
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return chain;
    },
    limit: async () => ({
      data: (options.runs ?? []).filter((run) =>
        filters.every(
          ([column, value]) =>
            column !== "input->>batchId" || (run as { input: { batchId: string } }).input.batchId === value,
        ),
      ),
      error: null,
    }),
    maybeSingle: async () => ({ data: { id: projectId, owner_id: ownerId }, error: null }),
  };
  const auth = { userId: ownerId, client: { rpc, from: () => chain } } as unknown as AuthenticatedContext;
  return { auth, calls: () => calls.filter((name) => name !== "get_generation_catalog"), filters };
}
beforeEach(() => {
  started.runs = [];
  started.fail = false;
  vi.stubEnv("EMBEL_SHARED_ACCOUNT_HTTP_ENABLED", "true");
});

describe("Creative directions with the engine kind off", () => {
  it("show the step as unavailable and fall back to nothing", async () => {
    const f = fixture({ enabled: false, answers: {} });
    expect(await getIdentityAvailability(f.auth, projectId)).toMatchObject({
      status: "unavailable",
      reason: "runtime_unavailable",
    });
    await expect(cancelIdentityBatch(f.auth, projectId, batchId)).rejects.toMatchObject({ code: "conflict" });
    expect(f.calls().filter((name) => name.includes("shared"))).toEqual([]);
    expect(started.runs).toEqual([]);
  });
});

describe("Creative directions with the engine kind on", () => {
  it("offer rounds under the engine's policy, even without the shared worker runtime", async () => {
    vi.stubEnv("EMBEL_SHARED_ACCOUNT_HTTP_ENABLED", "false");
    const f = fixture({ enabled: true, answers: { get_identity_directions_availability: { data: available } } });
    expect(await getIdentityAvailability(f.auth, projectId)).toMatchObject({
      status: "available",
      policyIdentity: ENGINE_IDENTITY_POLICY_IDENTITY,
    });
    expect(f.calls()).toEqual(["get_identity_directions_availability"]);
  });

  it("admit a round in one database call, then start its workflow once", async () => {
    const f = fixture({
      enabled: true,
      answers: { start_identity_directions: { data: { replayed: false, run: runRow(), batch: batch() } } },
    });
    expect(await enqueueIdentityBatch(f.auth, projectId, intent)).toMatchObject({ batchId, status: "running" });
    expect(f.calls()).toEqual(["start_identity_directions"]);
    expect(started.runs).toEqual([id(70)]);
    // A replay whose workflow already runs starts nothing.
    const replay = fixture({
      enabled: true,
      answers: {
        start_identity_directions: {
          data: { replayed: true, run: runRow({ status: "running", workflow_run_id: "wrun_1" }), batch: batch() },
        },
      },
    });
    await enqueueIdentityBatch(replay.auth, projectId, intent);
    expect(started.runs).toEqual([id(70)]);
    // A request the shared worker admitted earlier is returned as it is.
    const earlier = fixture({
      enabled: true,
      answers: { start_identity_directions: { data: { replayed: true, run: null, batch: batch() } } },
    });
    expect(await enqueueIdentityBatch(earlier.auth, projectId, intent)).toMatchObject({ batchId });
    expect(started.runs).toEqual([id(70)]);
  });

  it("start a replayed round only when its first start was evidently lost", async () => {
    const quick = fixture({
      enabled: true,
      answers: { start_identity_directions: { data: { replayed: true, run: runRow(), batch: batch() } } },
    });
    await enqueueIdentityBatch(quick.auth, projectId, intent);
    expect(started.runs).toEqual([]);
    const lost = fixture({
      enabled: true,
      answers: {
        start_identity_directions: {
          data: {
            replayed: true,
            run: runRow({ created_at: new Date(Date.now() - 60_000).toISOString() }),
            batch: batch(),
          },
        },
      },
    });
    await enqueueIdentityBatch(lost.auth, projectId, intent);
    expect(started.runs).toEqual([id(70)]);
  });

  it.each([
    ["insufficient_credits", "PT402", "insufficient_credits", 402],
    ["daily_limit", "PT429", "daily_limit", 429],
    ["generation_active", "PT409", "generation_active", 409],
    ["identity_generation_head_conflict", "PT409", "conflict", 409],
    ["identity_generation_unavailable", "55000", "generation_unavailable", 503],
  ])("answer a refused admission (%s) as final, with nothing started", async (message, code, expected, status) => {
    const f = fixture({ enabled: true, answers: { start_identity_directions: { error: { message, code } } } });
    await expect(enqueueIdentityBatch(f.auth, projectId, intent)).rejects.toMatchObject({ code: expected, status });
    expect(started.runs).toEqual([]);
  });

  it("keep an admission whose outcome is unknown, or whose workflow did not start, for a replay with the same key", async () => {
    const lost = fixture({
      enabled: true,
      answers: { start_identity_directions: { error: { message: "connection reset", code: "08006" } } },
    });
    await expect(enqueueIdentityBatch(lost.auth, projectId, intent)).rejects.toBeInstanceOf(
      IdentityAdmissionUncertainError,
    );
    started.fail = true;
    const unstarted = fixture({
      enabled: true,
      answers: { start_identity_directions: { data: { replayed: false, run: runRow(), batch: batch() } } },
    });
    await expect(enqueueIdentityBatch(unstarted.auth, projectId, intent)).rejects.toBeInstanceOf(
      IdentityAdmissionUncertainError,
    );
  });

  it("refuse a run that belongs to another batch or person", async () => {
    const f = fixture({
      enabled: true,
      answers: {
        start_identity_directions: { data: { replayed: false, run: runRow({ owner_id: id(99) }), batch: batch() } },
      },
    });
    await expect(enqueueIdentityBatch(f.auth, projectId, intent)).rejects.toMatchObject({
      code: "integration_unavailable",
    });
    expect(started.runs).toEqual([]);
  });

  it("stop an engine round through its run, whether or not the kind is still on, and close requests through the engine", async () => {
    for (const enabled of [true, false]) {
      const f = fixture({
        enabled,
        runs: [runRow({ status: "running", workflow_run_id: "wrun_1" })],
        answers: { cancel_identity_directions: { data: batch("cancel_requested") } },
      });
      expect(await cancelIdentityBatch(f.auth, projectId, batchId)).toMatchObject({ status: "cancel_requested" });
      expect(f.calls()).toEqual(["cancel_identity_directions"]);
    }
    const witness = { status: "not_admitted", ownerId, projectId, intent };
    const f = fixture({ enabled: true, answers: { close_identity_directions_intent: { data: witness } } });
    expect(await closeIdentityBatchRequest(f.auth, projectId, intent)).toEqual(witness);
    expect(f.calls()).toEqual(["close_identity_directions_intent"]);
  });

  it("start a working round whose workflow never started when it is checked", async () => {
    const stale = runRow({ created_at: new Date(Date.now() - 60_000).toISOString() });
    const f = fixture({ enabled: true, runs: [stale], answers: { get_shared_identity_batch: { data: batch() } } });
    expect(await getIdentityBatch(f.auth, projectId, batchId)).toMatchObject({ batchId });
    expect(started.runs).toEqual([id(70)]);
    expect(
      identityRunNeedsStart({
        id: id(70),
        status: "queued",
        workflow_run_id: null,
        created_at: new Date().toISOString(),
        batchId,
      }),
    ).toBe(false);
    expect(
      identityRunNeedsStart({
        id: id(70),
        status: "running",
        workflow_run_id: "wrun",
        created_at: "2026-11-09T00:00:00Z",
        batchId,
      }),
    ).toBe(false);
  });
});
