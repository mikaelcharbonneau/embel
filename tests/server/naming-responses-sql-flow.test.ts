import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingCreatorOutputSchema, namingProgressiveAssignmentSchema, namingResearchOutputSchema } from "../../src/domain/naming-brain";
import { namingResponsesRequestSchema, type NamingResponsesRequest } from "../../src/domain/naming-responses";
import { nameIdentityKey } from "../../src/domain/project-naming";
import type { ClaimedJob } from "../../src/domain/jobs";
import { buildNamingResponsesRoleBody } from "../../src/server/ai/naming-responses/prompts";
import { createNamingResponsesProtocol } from "../../src/server/ai/naming-responses/protocol";
import { createNamingResponsesRuntime } from "../../src/server/ai/naming-responses/runtime";
import { NamingResponsesJobStore } from "../../worker/naming-responses-store";
import { brainWorker } from "../database/naming-brain-fixture";
import { createTestDatabase, type TestDatabase } from "../database/local-supabase";
import { hashResponsesRequest, installNamingResponsesFixture, namingResponsesRequest, seedNamingResponsesFixture } from "../database/naming-responses-fixture";
import { snapshot } from "../domain/naming-brain-fixtures";

let db: TestDatabase;
beforeAll(async () => { db = await createTestDatabase(); await installNamingResponsesFixture(db); }, 30_000);
afterAll(async () => { await db?.close(); });

// Admin-only synthetic qualifications exercise the plumbing, not a real hosted
// search cost proof. This is deliberately not a public feed/publication test:
// production admission and the required research qualification remain closed.
it("retains mandatory synthetic research and100 creator records through SDK background recovery and a real capped SQL ledger", async () => {
  const f = await seedNamingResponsesFixture(db);
  const job: ClaimedJob = { id: f.jobId, ownerId: f.ownerId, projectId: f.projectId, input: f.marker, operation: "naming.generate", inputRevision: 1,
    leaseToken: f.leaseToken, status: "running", reservedCostMicrousd: 5_000_000, actualCostMicrousd: 0 };
  const store = new NamingResponsesJobStore(db, job);
  const brief = namingBriefSnapshotSchema.parse({ ...snapshot(), ownerId: f.ownerId, projectId: f.projectId, preferences: { ...snapshot().preferences, approaches: ["real_words"] } });
  const assignment = namingProgressiveAssignmentSchema.parse({ assignmentKey: "synthetic.all", primaryApproach: "real_words", additionalApproaches: [], territoryId: "nature", constructionKey: "whole_word",
    direction: "Synthetic brief-seeded fixture", targetCount: 100, sourceKeys: [], avoidPatterns: [], freshTerritory: true, runId: f.runId, snapshotHash: brief.snapshotHash,
    assignmentOrder: 0, round: "initial", sources: [], assignmentBasis: { kind: "brief_seed", snapshotHash: brief.snapshotHash } });
  const requests = [
    namingResponsesRequestSchema.parse(hashResponsesRequest({ ...namingResponsesRequest(f, "research", true), body: buildNamingResponsesRoleBody({ runId: f.runId, dispatchKey: "research", input: { role: "researcher", snapshot: brief } }) })),
    namingResponsesRequestSchema.parse(hashResponsesRequest({ ...namingResponsesRequest(f, "creator.0"), body: buildNamingResponsesRoleBody({ runId: f.runId, dispatchKey: "creator.0", input: { role: "creator", snapshot: brief, assignment } }) })),
  ];
  const research = namingResearchOutputSchema.parse({ role: "researcher", territories: [{ territoryId: "nature", title: "Synthetic nature", direction: "Synthetic reference material", sourceKeys: [] },
    { territoryId: "rhythm", title: "Synthetic rhythm", direction: "Synthetic alternate territory", sourceKeys: [] }], facts: [], interpretations: [], uncertainties: ["Synthetic HTTP only; no real facts or live quality claimed."] });
  const creation = namingCreatorOutputSchema.parse({ role: "creator", assignmentKey: assignment.assignmentKey, candidates: Array.from({ length: 100 }, (_, index) => ({ candidateKey: `synthetic_${index}`,
    value: `Cedarloom${String(index).padStart(3, "0")}`, primaryApproach: "real_words", additionalApproaches: [], territoryId: "nature", constructionKey: "whole_word", rationale: "Synthetic candidate only.", caution: null, claims: [] })) });
  const calls: { method: string; path: string }[] = [], byId = new Map<string, Record<string, unknown>>();
  function response(request: NamingResponsesRequest, status: string, output: unknown) {
    return { id: `resp_synthetic_${request.dispatchKey.replaceAll(".", "_")}`, object: "response", status, created_at: 1, background: true, model: request.body.model,
      metadata: request.body.metadata, reasoning: request.body.reasoning, prompt_cache_options: request.body.prompt_cache_options, service_tier: "default", tools: request.body.tools, text: request.body.text,
      max_output_tokens: request.body.max_output_tokens, ...(request.body.max_tool_calls === undefined ? {} : { max_tool_calls: request.body.max_tool_calls }),
      usage: { input_tokens: 500, output_tokens: 10_000, total_tokens: 10_500, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1000 } },
      output: status !== "completed" ? [] : [
        ...(request.dispatchKey === "research" ? [{ id: "ws_synthetic", type: "web_search_call", status: "completed", action: { type: "search", queries: ["Synthetic fixture only"] } }] : []),
        { id: `msg_${request.dispatchKey}`, type: "message", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify(output) }] },
      ] };
  }
  const protocol = createNamingResponsesProtocol({ apiKey: "synthetic-not-a-real-key", fetch: async (incoming, init) => {
    const outgoing = new Request(incoming, init), url = new URL(outgoing.url); calls.push({ method: outgoing.method, path: url.pathname });
    expect(url.origin).toBe("https://api.openai.com");
    if (outgoing.method === "GET") {
      const saved = byId.get(url.pathname.split("/").at(-1)!); expect(saved).toBeDefined(); return Response.json(saved);
    }
    expect(url.pathname).toBe("/v1/responses");
    const body = await outgoing.json() as { metadata: { embel_dispatch: string } };
    const request = requests.find(item => item.dispatchKey === body.metadata.embel_dispatch)!; expect(body).toEqual(request.body);
    const output = request.dispatchKey === "research" ? research : creation;
    const final = response(request, "completed", output); byId.set(String(final.id), final);
    // Research loses its streaming tail but retains a known background handle.
    const events = request.dispatchKey === "research" ? [{ type: "response.created", sequence_number: 0, response: response(request, "in_progress", output) }]
      : [{ type: "response.created", sequence_number: 0, response: response(request, "in_progress", output) }, { type: "response.completed", sequence_number: 1, response: final }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-request-id": `req_synthetic_${request.dispatchKey.replaceAll(".", "_")}` } });
  } });
  const runtime = createNamingResponsesRuntime({ protocol, persistence: store });
  const reservation = (await db.query("select * from public.usage_reservations where job_id=$1", [f.jobId])).rows;
  const researchResult = await brainWorker(db, () => runtime.run(requests[0]!, { signal: new AbortController().signal }));
  expect(researchResult, JSON.stringify(researchResult)).toMatchObject({ status: "completed", requiresExplicitContinuation: false, output: research });
  const result = await brainWorker(db, () => runtime.run(requests[1]!, { signal: new AbortController().signal }));
  expect(result.status).toBe("completed"); if (result.status !== "completed") throw Error("Synthetic creator did not complete");
  const candidates = namingCreatorOutputSchema.parse(result.output).candidates;
  expect(candidates).toHaveLength(100); expect(new Set(candidates.map(candidate => nameIdentityKey(candidate.value))).size).toBe(100);
  const saved = await brainWorker(db, () => store.load());
  expect(saved.allocatedCostNanoUsd).toBe(509_152_000); expect(saved.maximumCostNanoUsd).toBe(5_000_000_000);
  expect(saved.dispatches.map(row => row.state)).toEqual(["terminal", "terminal"]);
  expect(calls.filter(call => call.method === "POST")).toHaveLength(2);
  expect(calls.filter(call => call.method === "GET")).toHaveLength(1);
  const before = calls.length;
  expect(await brainWorker(db, () => runtime.run(requests[1]!, { signal: new AbortController().signal }))).toMatchObject({ status: "completed" });
  expect(await brainWorker(db, () => runtime.resume("research", { signal: new AbortController().signal, observeOnly: true }))).toMatchObject({ status: "completed" });
  expect(calls).toHaveLength(before);
  expect((await db.query("select * from public.usage_reservations where job_id=$1", [f.jobId])).rows).toEqual(reservation);
  expect((await db.query("select count(*)::integer n from fluid_private.naming_brain_feed_entries where run_id=$1", [f.runId])).rows).toEqual([{ n: 0 }]);
});
