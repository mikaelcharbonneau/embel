import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { contextSnapshotSchema } from "../../src/domain/projects";
import { getNamingReadiness, nameIdentityKey, namingStrategyBasis, namingStrategyKey } from "../../src/domain/project-naming";
import { getNamingBatch } from "../../src/server/data/project-naming";
import type { AuthenticatedContext } from "../../src/server/auth/context";

const id = (n: number) => `30000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const ownerId = id(1), projectId = id(2), batchId = id(3), jobId = id(4), at = "2026-10-05T04:12:33Z";
const context = contextSnapshotSchema.parse({ description: "Explicit local 250-name pagination fixture" });
const preferences = { version: 1, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null };

/** Synthetic persisted RPC replies only; no provider call or hosted database. */
function fixture(targetCount: 250 | 100 | 50 = 250, acceptedCount: number = targetCount) {
  const sequence = targetCount === 50 ? 2 : 1;
  const batch = {
    id: batchId, ownerId, projectId, contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context),
    preferencesVersion: 1, preferences, favoritesSnapshot: [], acceptedPolicyIdentity: "a".repeat(64), targetCount, sequence, jobId, createdAt: at,
  };
  const accepted = Array.from({ length: acceptedCount }, (_, index) => {
    const value = `FixtureName${index.toString().padStart(3, "0")}`;
    return { value, identityKey: nameIdentityKey(value), rationale: `Explicit synthetic explanation ${index}.` };
  });
  const fulfillment = {
    status: acceptedCount === targetCount ? "complete" : acceptedCount > 0 ? "partial" : "none", targetCount, acceptedCount,
    rejections: { invalid_candidate: 0, empty_identity: 0, below_minimum: 0, above_maximum: 0, duplicate_response: 0, duplicate_history: 0, over_target: 0 },
    message: acceptedCount === targetCount ? null : `${acceptedCount} of ${targetCount} passed validation.`,
  };
  const output = {
    version: 1, operation: "naming.generate", provider: "openai", billingMode: "chatgpt_subscription", model: "fixture-model", responseId: "fixture-response", requestId: null,
    generatedAt: at, usage: null, batchId, sequence, targetCount, accepted, fulfillment,
  };
  const entries = accepted.map((row, index) => {
    const candidateId = id(1000 + index);
    return {
      candidate: {
        id: candidateId, ownerId, projectId, ...row, contextRevision: 1, strategyBasis: batch.strategyBasis, strategyKey: batch.strategyKey, createdAt: at,
        origin: { kind: "generated", ownerId, projectId, candidateId, value: row.value, contextRevision: 1, batchId, jobId, stepKey: "names", provider: "openai", billingMode: "chatgpt_subscription", model: "fixture-model", responseId: "fixture-response", requestId: null, generatedAt: at },
      },
      retention: { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null },
    };
  });
  const result = { ownerId, projectId, batchId, jobId, stepKey: "names", candidateIds: entries.map(row => row.candidate.id), fulfillment, completedAt: at };
  const job = {
    id: jobId, owner_id: ownerId, project_id: projectId, operation: "naming.generate", input_revision: 1, state: "succeeded", progress: 100, error_code: null,
    cancel_requested_at: null, created_at: at, finished_at: at, billingMode: "chatgpt_subscription", policyIdentity: batch.acceptedPolicyIdentity, batchId, sequence, targetCount,
    results: [{ stepKey: "names", output }],
  };
  const detail = { batch, job, result };
  function page(start: number, count: number) {
    const items = entries.slice(start, start + count);
    const last = items.at(-1)?.candidate;
    return {
      project: { id: projectId, owner_id: ownerId, title: "Synthetic pagination brief", scope: "naming_only", current_revision: 1, created_at: at, context },
      readiness: getNamingReadiness(context, "naming_only"),
      session: { ownerId, projectId, revision: 1, currentPreferencesVersion: 1, latestBatchSequence: sequence, currentSelectionId: null, viewRevision: 1,
        viewState: { pane: "results", conversationOpen: false, filter: "all", query: "", visibleBatchId: null, scrollCandidateId: null, workshopCandidateId: null }, createdAt: at, updatedAt: at },
      preferences: { ownerId, projectId, version: 1, preferences, createdAt: at }, currentSelection: null,
      batches: { ownerId, projectId, items: [{ batch, result }], nextCursor: null },
      candidates: { ownerId, projectId, items, nextCursor: start + count < acceptedCount && last ? { createdAt: last.createdAt, id: last.id } : null },
      availability: { status: "unavailable", operation: "naming.generate", reason: "naming_policy_unavailable" }, jobs: [job],
      screening: { domains: { status: "not_checked", reason: "integration_unavailable" }, handles: { status: "not_checked", reason: "integration_unavailable" }, trademarks: { status: "not_checked", reason: "integration_unavailable" } },
    };
  }
  const pages = Array.from({ length: Math.ceil(acceptedCount / 100) }, (_, index) => page(index * 100, 100));
  return { detail, entries, page, pages };
}
type Fixture = ReturnType<typeof fixture>;
function client(data: Fixture, pages: Fixture["pages"] = data.pages) {
  let pageIndex = 0;
  const rpc = vi.fn(async (name: string) => {
    if (name === "get_naming_batch") return { data: data.detail, error: null };
    if (name === "get_project_naming") return { data: pages[pageIndex++], error: null };
    throw new Error(`Unexpected synthetic RPC: ${name}`);
  });
  return { auth: { userId: ownerId, client: { rpc } } as unknown as AuthenticatedContext, rpc };
}
const unavailable = { code: "integration_unavailable" };

describe("bounded exact Naming batch publication pagination", () => {
  it("verifies all 250 published rows through 100 + 100 + 50 scoped pages with explanations", async () => {
    const data = fixture(); const { auth, rpc } = client(data);
    const read = await getNamingBatch(auth, projectId, batchId);
    expect(read.result!.candidateIds).toEqual(data.entries.map(row => row.candidate.id));
    expect(new Set(read.result!.candidateIds).size).toBe(250);
    expect(data.entries.every(row => row.candidate.rationale.length > 0)).toBe(true);
    const queries = rpc.mock.calls.filter(([name]) => name === "get_project_naming");
    expect(queries).toEqual([
      ["get_project_naming", { p_project_id: projectId, p_query: { batchId, limit: 100, filter: "all", query: "" } }],
      ["get_project_naming", { p_project_id: projectId, p_query: { batchId, limit: 100, filter: "all", query: "", cursor: data.pages[0]!.candidates.nextCursor } }],
      ["get_project_naming", { p_project_id: projectId, p_query: { batchId, limit: 50, filter: "all", query: "", cursor: data.pages[1]!.candidates.nextCursor } }],
    ]);
    expect(rpc.mock.calls.filter(([name]) => name === "get_naming_batch")).toHaveLength(1);
  });
  it.each([100, 50] as const)("retains a historical %s-target batch with one bounded page", async target => {
    const data = fixture(target); const { auth, rpc } = client(data);
    expect((await getNamingBatch(auth, projectId, batchId)).result!.candidateIds).toHaveLength(target);
    expect(rpc.mock.calls.filter(([name]) => name === "get_project_naming")).toEqual([["get_project_naming", { p_project_id: projectId, p_query: { batchId, limit: target, filter: "all", query: "" } }]]);
  });
  it("verifies 149 accepted rows of a 250 target without inventing the missing 101", async () => {
    const data = fixture(250, 149); const { auth, rpc } = client(data);
    const read = await getNamingBatch(auth, projectId, batchId);
    expect(read.result!.fulfillment).toMatchObject({ status: "partial", acceptedCount: 149, targetCount: 250 });
    expect(rpc.mock.calls.filter(([name]) => name === "get_project_naming")).toHaveLength(2);
    expect(rpc).toHaveBeenLastCalledWith("get_project_naming", { p_project_id: projectId, p_query: { batchId, limit: 49, filter: "all", query: "", cursor: data.pages[0]!.candidates.nextCursor } });
  });
  it("accepts publication ID order independently of stable candidate pagination order", async () => {
    const data = fixture(); data.detail.result.candidateIds.reverse(); data.pages = Array.from({ length: 3 }, (_, index) => data.page(index * 100, 100));
    const { auth } = client(data);
    expect((await getNamingBatch(auth, projectId, batchId)).result!.candidateIds).toEqual(data.detail.result.candidateIds);
  });
  it("does not page an honestly empty publication", async () => {
    const data = fixture(250, 0); const { auth, rpc } = client(data);
    expect((await getNamingBatch(auth, projectId, batchId)).result!.fulfillment.status).toBe("none");
    expect(rpc.mock.calls).toHaveLength(1);
  });
  it("fails closed on a missing final published row", async () => {
    const data = fixture(); data.pages[2]!.candidates.items.pop(); const { auth } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
  });
  it("fails closed on an early terminal cursor before all published IDs are read", async () => {
    const data = fixture(); data.pages[0]!.candidates.nextCursor = null; const { auth, rpc } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
    expect(rpc.mock.calls.filter(([name]) => name === "get_project_naming")).toHaveLength(1);
  });
  it("rejects a candidate repeated across otherwise valid individual pages", async () => {
    const data = fixture(); data.pages[1]!.candidates.items[0] = structuredClone(data.entries[0]!); const { auth, rpc } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
    expect(rpc.mock.calls.filter(([name]) => name === "get_project_naming")).toHaveLength(2);
  });
  it("rejects a schema-valid candidate ID absent from the immutable publication", async () => {
    const data = fixture(); const entry = data.pages[1]!.candidates.items[0]!;
    entry.candidate.id = id(9999); entry.candidate.origin.candidateId = id(9999); entry.retention.candidateId = id(9999);
    const { auth } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
  });
  it("rejects another batch's generated origin without fetching that batch", async () => {
    const data = fixture(); data.pages[1]!.candidates.items[0]!.candidate.origin.batchId = id(90); const { auth, rpc } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
    expect(rpc.mock.calls.filter(([name]) => name === "get_naming_batch")).toHaveLength(1);
  });
  it("rechecks the 250th candidate against the persisted provider explanation", async () => {
    const data = fixture(); data.pages[2]!.candidates.items[49]!.candidate.rationale = "Forged final explanation."; const { auth } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
  });
  it("rejects a foreign owner on a later page", async () => {
    const data = fixture(); data.pages[1]!.candidates.items[0]!.candidate.ownerId = id(99); const { auth, rpc } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject({ code: "not_found" });
    expect(rpc.mock.calls.filter(([name]) => name === "get_project_naming")).toHaveLength(2);
  });
  it("rejects a foreign project on a later page", async () => {
    const data = fixture(); data.pages[1]!.project.id = id(99); const { auth } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
  });
  it("does not return already checked pages after a later RPC fails", async () => {
    const data = fixture(); const { auth, rpc } = client(data);
    rpc.mockImplementationOnce(async () => ({ data: data.detail, error: null }));
    rpc.mockImplementationOnce(async () => ({ data: data.pages[0], error: null }));
    rpc.mockImplementationOnce(async () => ({ data: null, error: { code: "XX000" } }) as never);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
    expect(rpc.mock.calls).toHaveLength(3);
  });
  it("rejects a cursor cycle without making an unbounded request sequence", async () => {
    const data = fixture(); const { auth, rpc } = client(data, [data.pages[0]!, data.pages[0]!, data.pages[0]!]);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
    expect(rpc.mock.calls.filter(([name]) => name === "get_project_naming").length).toBeLessThanOrEqual(2);
  });
  it("rejects a regressing cursor with fresh candidate IDs", async () => {
    const data = fixture(); const page = data.pages[1]!;
    for (const entry of page.candidates.items) entry.candidate.createdAt = "2026-10-05T04:12:32Z";
    page.candidates.nextCursor!.createdAt = "2026-10-05T04:12:32Z";
    const { auth, rpc } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
    expect(rpc.mock.calls.filter(([name]) => name === "get_project_naming")).toHaveLength(2);
  });
  it("fails closed on a short nonterminal page within the frozen target budget", async () => {
    const data = fixture(); data.pages[0] = data.page(0, 1); const { auth, rpc } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
    expect(rpc.mock.calls.filter(([name]) => name === "get_project_naming")).toHaveLength(1);
  });
  it("refuses a fourth page after the 250 target is exhausted", async () => {
    const data = fixture(); const last = data.pages[2]!.candidates.items.at(-1)!.candidate;
    data.pages[2]!.candidates.nextCursor = { id: last.id, createdAt: last.createdAt };
    const { auth, rpc } = client(data);
    await expect(getNamingBatch(auth, projectId, batchId)).rejects.toMatchObject(unavailable);
    expect(rpc.mock.calls.filter(([name]) => name === "get_project_naming")).toHaveLength(3);
  });
  it.each([
    ["2026-10-05T04:12:33.123001Z", "2026-10-05T04:12:33.123002Z"],
    ["2026-10-05T05:12:33.123001+01:00", "2026-10-05T04:12:33.123002Z"],
  ])("preserves database microsecond order between %s and %s despite descending IDs", async (first, second) => {
    const data = fixture(100, 2);
    for (const [index, entry] of data.entries.entries()) {
      const candidateId = id(1001 - index);
      entry.candidate.id = candidateId; entry.candidate.origin.candidateId = candidateId; entry.retention.candidateId = candidateId;
      entry.candidate.createdAt = index === 0 ? first : second;
    }
    data.pages = [data.page(0, 100)]; const { auth } = client(data);
    expect((await getNamingBatch(auth, projectId, batchId)).result!.candidateIds).toHaveLength(2);
  });
  it("preserves microsecond cursor order across the boundary between full pages", async () => {
    const data = fixture();
    for (const [index, entry] of data.entries.entries()) {
      const candidateId = id(1000 + (index < 100 ? index + 100 : index < 200 ? index - 100 : index));
      entry.candidate.id = candidateId; entry.candidate.origin.candidateId = candidateId; entry.retention.candidateId = candidateId;
      entry.candidate.createdAt = `2026-10-05T04:12:33.12300${Math.floor(index / 100) + 1}Z`;
    }
    data.pages = Array.from({ length: 3 }, (_, index) => data.page(index * 100, 100)); const { auth, rpc } = client(data);
    expect((await getNamingBatch(auth, projectId, batchId)).result!.candidateIds).toHaveLength(250);
    expect(rpc.mock.calls.filter(([name]) => name === "get_project_naming")).toHaveLength(3);
  });
  it("uses ID order for equivalent instants with differing offsets and trailing fractional zeros", async () => {
    const data = fixture(100, 2);
    data.entries[0]!.candidate.createdAt = "2026-10-05T05:12:33.1230+01:00";
    data.entries[1]!.candidate.createdAt = "2026-10-05T04:12:33.123000Z";
    data.pages = [data.page(0, 100)]; const { auth } = client(data);
    expect((await getNamingBatch(auth, projectId, batchId)).result!.candidateIds).toHaveLength(2);
  });
});
