import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { chatGPTStrategyJobInputSchema, DEFAULT_SUBSCRIPTION_LIMITS, strategyOperationSchema } from "../../src/domain/strategy-jobs";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { createChatGPTStrategyRequest } from "../../src/server/ai/chatgpt-strategy";
import { asRole, asSubscriptionWorker, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";

// Explicit local PostgreSQL fixtures; no providers or hosted database access.
const policy = { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "strategy-chatgpt-v1", registrationId: "history-fixture-registration", model: "fixture-model", limits: DEFAULT_SUBSCRIPTION_LIMITS };
const output = { version: 1, provider: "openai", model: "fixture-model", responseId: "fixture-response", requestId: null, generatedAt: "2026-10-03T12:00:00Z", operation: "strategy.reformulate",
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 }, proposal: { message: "Synthetic prior answer", activity: "Classes", offering: "Small evening groups", knownAudience: "Adults", questions: ["Beginners or experienced makers?"] } };

describe("server-owned subscription assistant history (local PostgreSQL)", () => {
  let db: TestDatabase, project: string, identity: string;
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await resetFixture(db);
    project = (await seedProject(db)).id;
    await asSubscriptionWorker(db, OWNER_A, async () => {
      await db.query("select public.configure_subscription_runtime($1,'strategy.reformulate',$2::jsonb,true)", [OWNER_A, JSON.stringify(policy)]);
      await db.query("select public.report_subscription_worker_ready($1,$2,'strategy.reformulate',$3::jsonb,60)", [OWNER_A, policy.registrationId, JSON.stringify(policy)]);
    });
    identity = (await db.query<{ identity: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as identity", [JSON.stringify(policy)])).rows[0]!.identity;
  });
  async function source(options: { owner?: string; projectId?: string; revision?: number; state?: string; stepState?: string; completedAt?: string; value?: unknown; responseId?: string } = {}) {
    const id = randomUUID(), owner = options.owner ?? OWNER_A, projectId = options.projectId ?? project;
    const completedAt = options.completedAt ?? new Date(Date.now() - 60_000).toISOString();
    await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,state,finished_at) values($1::uuid,$2,$3,'strategy.reformulate',$4,$5,$6::jsonb,$1::text,0,$7,$8)", [id, owner, projectId, options.revision ?? 1, HASH, JSON.stringify({ policy: { model: "fixture-model" } }), options.state ?? "succeeded", completedAt]);
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,output,provider_request_id,completed_at) values($1::uuid,$2,$3,'respond',$1::text,$4,0,$5::jsonb,$6,$7)", [id, owner, projectId, options.stepState ?? "succeeded", JSON.stringify(options.value ?? output), options.responseId ?? output.responseId, completedAt]);
    return id;
  }
  async function submit(key = "history-local-request-0001", revision = 1) {
    return asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ result: { id: string } }>("select public.enqueue_subscription_strategy_job($1,$4,'strategy.reformulate',$2,$3) as result", [project, key, identity, revision])).rows[0]!.result);
  }
  async function stored(id: string) {
    return (await db.query<{ input: unknown; input_hash: string; hash_matches: boolean }>("select input,input_hash,input_hash=encode(sha256(convert_to(input::text,'UTF8')),'hex') as hash_matches from public.jobs where id=$1", [id])).rows[0]!;
  }

  it("freezes complete owned results and their database provenance in v2 without changing the selected policy", async () => {
    const sourceId = await source(); const queued = await submit(); const row = await stored(queued.id);
    const input = chatGPTStrategyJobInputSchema.parse(row.input);
    expect(input.version).toBe(2);
    expect(input.policy).toEqual(policy);
    expect(input.assistantHistory).toMatchObject({ truncated: false, entries: [{ jobId: sourceId, ownerId: OWNER_A, projectId: project, inputRevision: 1, stepKey: "respond", output }] });
    expect(row.hash_matches).toBe(true);
    const claim = await asSubscriptionWorker(db, OWNER_A, () => db.query<{ input: unknown }>("select * from public.claim_subscription_job('history-fixture-worker',$1,$2,60)", [OWNER_A, policy.registrationId]));
    expect(claim.rows[0]!.input).toEqual(row.input);
  });

  it("excludes foreign owners/projects, future revisions, incomplete output and mismatched source provenance", async () => {
    const own = await source();
    const foreign = (await seedProject(db, OWNER_B)).id, other = (await seedProject(db)).id;
    await source({ owner: OWNER_B, projectId: foreign }); await source({ projectId: other });
    await db.query("insert into public.project_revisions(project_id,owner_id,revision,context,input_hash) values($1,$2,2,'{}'::jsonb,$3)", [project, OWNER_A, HASH]);
    await source({ revision: 2 });
    await source({ stepState: "ambiguous", value: { partialText: "Synthetic partial" } });
    await source({ state: "failed" });
    await source({ value: { ...output, operation: "strategy.positioning" } });
    await source({ value: { ...output, model: "different-model" } });
    await source({ responseId: "different-response" });
    await source({ value: { ...output, reasoning: "Synthetic excluded reasoning" } });
    await source({ completedAt: new Date(Date.now() + 60_000).toISOString() });
    const input = chatGPTStrategyJobInputSchema.parse((await stored((await submit()).id)).input);
    expect(input.assistantHistory.entries.map(entry => entry.jobId)).toEqual([own]);
    expect(JSON.stringify(input)).not.toMatch(/Synthetic partial|Synthetic excluded reasoning/);
  });

  it("retains the real durable subscription reply for a follow-up without treating its suggestions as applied", async () => {
    const original = await submit();
    const result = { ...output, billingMode: "chatgpt_subscription", usage: null };
    await asSubscriptionWorker(db, OWNER_A, async () => {
      const claimed = (await db.query<{ id: string; lease_token: string }>("select * from public.claim_subscription_job('history-fixture-worker',$1,$2,60)", [OWNER_A, policy.registrationId])).rows[0]!;
      await db.query("select public.register_job_plan($1,$2,'[{\"key\":\"respond\",\"maximumCostMicrousd\":0}]'::jsonb)", [claimed.id, claimed.lease_token]);
      await db.query("select public.begin_job_step($1,$2,'respond','history-source-request',0)", [claimed.id, claimed.lease_token]);
      await db.query("select public.complete_job_step($1,$2,'respond','succeeded',0,$3::jsonb,$4)", [claimed.id, claimed.lease_token, JSON.stringify(result), result.responseId]);
      await db.query("select public.finish_job($1,$2,'succeeded')", [claimed.id, claimed.lease_token]);
    });
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.append_project_revision($1,1,$2::jsonb,$3)", [project, JSON.stringify({ description: "Explicit local fixture", intake: { conversation: [{ id: "history-follow-up", kind: "user_message", text: "The second audience you suggested.", createdAt: "2026-10-03T12:01:00Z" }] } }), HASH]));
    const followUp = await submit("history-follow-up-request", 2);
    const input = chatGPTStrategyJobInputSchema.parse((await stored(followUp.id)).input);
    expect(input.assistantHistory.entries).toHaveLength(1);
    expect(input.assistantHistory.entries[0]).toMatchObject({ jobId: original.id, inputRevision: 1, output: result });
    expect(input.context.intake.conversation?.[0]).toHaveProperty("text", "The second audience you suggested.");
    expect(input.context.activity).toBe("");
    expect((await db.query("select * from public.strategy_job_applications")).rows).toEqual([]);
  });

  it("keeps the original history and hash on idempotent recovery despite newly completed output", async () => {
    await source(); const first = await submit(); const snapshot = await stored(first.id);
    await source({ value: { ...output, proposal: { ...output.proposal, message: "Newly completed after enqueue" } } });
    expect((await submit()).id).toBe(first.id);
    expect((await submit("history-new-request-nonce")).id).toBe(first.id);
    expect(await stored(first.id)).toEqual(snapshot);
  });

  it("selects the five newest complete sources and signals omitted history", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 7; index++) ids.push(await source({ completedAt: new Date(Date.now() - 600_000 + index * 1000).toISOString() }));
    const input = chatGPTStrategyJobInputSchema.parse((await stored((await submit()).id)).input);
    expect(input.assistantHistory.entries.map(entry => entry.jobId)).toEqual(ids.slice(2).reverse());
    expect(input.assistantHistory.truncated).toBe(true);
  });

  it("bounds UTF-8 history without slicing a proposal or expanding configured limits", async () => {
    for (let index = 0; index < 5; index++) await source({ value: { ...output, proposal: { ...output.proposal, message: "é".repeat(6000) } }, completedAt: new Date(Date.now() - 600_000 + index * 1000).toISOString() });
    const input = chatGPTStrategyJobInputSchema.parse((await stored((await submit()).id)).input);
    expect(input.assistantHistory.truncated).toBe(true);
    expect(input.assistantHistory.entries.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(input.assistantHistory))).toBeLessThanOrEqual(32_768);
    expect(input.assistantHistory.entries.every(entry => entry.output.proposal.message === "é".repeat(6000))).toBe(true);
    expect(input.policy.limits).toEqual(DEFAULT_SUBSCRIPTION_LIMITS);
  });

  it("omits oversized whole sources under a smaller selected input limit and records that omission", async () => {
    const limited = { ...policy, limits: { ...policy.limits, maxInputBytes: 16_384 } };
    await asSubscriptionWorker(db, OWNER_A, async () => {
      await db.query("select public.configure_subscription_runtime($1,'strategy.reformulate',$2::jsonb,true)", [OWNER_A, JSON.stringify(limited)]);
      await db.query("select public.report_subscription_worker_ready($1,$2,'strategy.reformulate',$3::jsonb,60)", [OWNER_A, limited.registrationId, JSON.stringify(limited)]);
    });
    identity = (await db.query<{ identity: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as identity", [JSON.stringify(limited)])).rows[0]!.identity;
    await source({ value: { ...output, proposal: { ...output.proposal, message: "é".repeat(6000) } } });
    const input = chatGPTStrategyJobInputSchema.parse((await stored((await submit()).id)).input);
    expect(input.assistantHistory).toEqual({ entries: [], truncated: true });
    expect(input.policy).toEqual(limited);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(limited.limits.maxInputBytes);
  });

  it("accounts for JSON escaping in the complete provider request before admitting prior proposals", async () => {
    const limited = { ...policy, limits: { ...policy.limits, maxInputBytes: 65_536 } };
    const context = contextSnapshotSchema.parse({ description: "d".repeat(12000), activity: "a".repeat(2000), offering: "o".repeat(2000), knownAudience: "k".repeat(2000), positioning: "p".repeat(2000) });
    project = await asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ id: string }>("select * from public.create_project('complete_brand','Escaped history fixture',$1::jsonb,$2)", [JSON.stringify(context), HASH])).rows[0]!.id);
    await asSubscriptionWorker(db, OWNER_A, async () => {
      await db.query("select public.configure_subscription_runtime($1,'strategy.reformulate',$2::jsonb,true)", [OWNER_A, JSON.stringify(limited)]);
      await db.query("select public.report_subscription_worker_ready($1,$2,'strategy.reformulate',$3::jsonb,60)", [OWNER_A, limited.registrationId, JSON.stringify(limited)]);
    });
    identity = (await db.query<{ identity: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as identity", [JSON.stringify(limited)])).rows[0]!.identity;
    for (let index = 0; index < 2; index++) await source({ value: { ...output, responseId: `escaped-response-${index}`, proposal: { ...output.proposal, message: "\\".repeat(6000) } }, responseId: `escaped-response-${index}` });
    const input = chatGPTStrategyJobInputSchema.parse((await stored((await submit()).id)).input);
    for (const operation of strategyOperationSchema.options) {
      const request = createChatGPTStrategyRequest(operation, input.context, input.policy.model, input.assistantHistory);
      expect(Buffer.byteLength(JSON.stringify({ ...request, store: false, stream: true }))).toBeLessThanOrEqual(limited.limits.maxInputBytes);
    }
    expect(input.assistantHistory.entries).toHaveLength(1);
    expect(input.assistantHistory.truncated).toBe(true);
    expect(input.assistantHistory.entries[0]!.output.proposal.message).toBe("\\".repeat(6000));
  });

  it("rejects extra caller history and direct job-input writes at the database boundary", async () => {
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select public.enqueue_subscription_strategy_job($1,1,'strategy.reformulate','history-forged-request',$2,'{}'::jsonb)", [project, identity]))).rejects.toMatchObject({ code: "42883" });
    const queued = await submit();
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("update public.jobs set input=jsonb_set(input,'{assistantHistory}','{}'::jsonb) where id=$1", [queued.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(asSubscriptionWorker(db, OWNER_A, () => db.query("select output from public.job_steps"))).rejects.toMatchObject({ code: "42501" });
  });
});
