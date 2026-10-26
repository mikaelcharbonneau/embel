import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TestDatabase } from "./local-supabase";
import { OWNER_A, OWNER_B } from "./local-supabase";
import { brainWorker, installBrainFixture, seedBrainFixture } from "./naming-brain-fixture";

export function canonicalResponsesJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalResponsesJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalResponsesJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function hashResponsesRequest<T extends { requestHash: string }>(request: T): T {
  return { ...request, requestHash: createHash("sha256").update(canonicalResponsesJson({ ...request, requestHash: "0".repeat(64) })).digest("hex") };
}
export async function installNamingResponsesFixture(db: TestDatabase) {
  await db.exec(await readFile(new URL("../../supabase/candidates/naming-responses-ledger.sql", import.meta.url), "utf8"));
  await installBrainFixture(db);
  await db.exec("grant execute on function public.naming_responses_worker_action(uuid,uuid,text,jsonb) to fixture_naming_brain_a,fixture_naming_brain_b");
}
export async function seedNamingResponsesFixture(db: TestDatabase) {
  const projectId = await seedBrainFixture(db), jobId = crypto.randomUUID(), runId = crypto.randomUUID(), leaseToken = crypto.randomUUID();
  const marker = { version: 3, handlerVersion: "naming-responses-v1", protocol: "openai_responses", runId, model: "gpt-6-luna", reasoningEffort: "xhigh", targetCount: 100 };
  await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode,state,lease_token,lease_expires_at,worker_id) values($1,$2,$3,'naming.generate',1,$4,$5,$6,5000000,1,'openai_api','running',$7,clock_timestamp()+interval '10 minutes','fixture-worker')", [jobId, OWNER_A, projectId, "a".repeat(64), marker, `synthetic-responses-${jobId}`, leaseToken]);
  await db.query("insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) values($1,$2,$3,5000000)", [jobId, OWNER_A, projectId]);
  await db.query("update public.usage_accounts set reserved_microusd=reserved_microusd+5000000 where owner_id=$1", [OWNER_A]);
  let until = (await db.query<{ until: string }>("select to_char((clock_timestamp()+interval '1 day') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') until")).rows[0]!.until;
  await db.query("insert into fluid_private.naming_responses_rate_cards values('synthetic-standard','gpt-6-luna',200,750,10000000,$1,'{\"kind\":\"synthetic fixture only\"}') on conflict do nothing", [until]);
  await db.query("insert into fluid_private.naming_responses_qualifications values('synthetic-plaintext','synthetic-standard',false,true,1050000,32768,0,$1,'{\"kind\":\"synthetic fixture only\"}'),('synthetic-research','synthetic-standard',true,true,1050000,32768,20,$1,'{\"kind\":\"synthetic proof, never live qualification\"}') on conflict do nothing", [until]);
  until = (await db.query<{ until: string }>("select to_char(valid_until at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') until from fluid_private.naming_responses_rate_cards where id='synthetic-standard'")).rows[0]!.until;
  return { projectId, jobId, runId, leaseToken, until, marker, ownerId: OWNER_A };
}
export type NamingResponsesFixture = Awaited<ReturnType<typeof seedNamingResponsesFixture>>;
export function namingResponsesRequest(f: NamingResponsesFixture, dispatchKey = "creator.0", research = false, patch: Record<string, unknown> = {}) {
  const maximumToolCalls = research ? 4 : 0, maximumOutputTokens = 32768;
  return hashResponsesRequest({ version: 1, protocol: "openai_responses", runId: f.runId, dispatchKey, requestHash: "0".repeat(64),
    body: { model: "gpt-6-luna", reasoning: { effort: "xhigh", mode: "standard" }, service_tier: "default", prompt_cache_options: { mode: "explicit", ttl: "30m" },
      truncation: "disabled", background: true, store: true, stream: true, parallel_tool_calls: false, max_output_tokens: maximumOutputTokens,
      ...(research ? { max_tool_calls: maximumToolCalls } : {}),
      input: "Synthetic naming only — café", instructions: "Synthetic frozen naming fixture only.", include: ["reasoning.encrypted_content", ...(research ? ["web_search_call.action.sources"] : [])], tool_choice: "auto", text: { verbosity: "low", format: { type: "json_schema", name: "synthetic_names", strict: true, schema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"], additionalProperties: false } } },
      metadata: { embel_run: f.runId, embel_dispatch: dispatchKey, embel_contract: "naming-responses-v1", embel_owner: f.ownerId, embel_project: f.projectId },
      tools: research ? [{ type: "web_search", search_context_size: "low", filters: { allowed_domains: ["merriam-webster.com"] } }, { type: "function", name: "read_reference", description: "Read the actual referenced page.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false }, strict: true }] : [] },
    quote: { rateCardId: "synthetic-standard", qualificationId: research ? "synthetic-research" : "synthetic-plaintext", validUntil: f.until, maximumInputTokens: 1050000, maximumOutputTokens, maximumToolCalls,
      maximumCostNanoUsd: 1050000 * 200 + maximumOutputTokens * 750 + maximumToolCalls * 10000000 }, ...patch });
}
export async function namingResponsesAction<T = Record<string, unknown>>(db: TestDatabase, f: NamingResponsesFixture, action: string, payload: unknown = {}, owner = OWNER_A): Promise<T> {
  return brainWorker(db, async () => (await db.query<{ result: T }>("select public.naming_responses_worker_action($1,$2,$3,$4::jsonb) result", [f.jobId, f.leaseToken, action, JSON.stringify(payload)])).rows[0]!.result, owner);
}
export function namingResponsesResponse(r: ReturnType<typeof namingResponsesRequest>, responseId: string, status = "completed", patch: Record<string, unknown> = {}) {
  return { ...r.body, object: "response", id: responseId, status, output: [], usage: null, ...patch };
}
export { OWNER_A, OWNER_B };
