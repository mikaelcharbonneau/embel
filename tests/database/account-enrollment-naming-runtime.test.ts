import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainJobInputSchema, type NamingModelOutput, type NamingStageRequest } from "../../src/domain/naming-brain";
import { createNamingBrainPolicy } from "../../src/server/ai/naming-brain/policy";
import { buildNamingManagedRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol, type ManagedCreateRequest } from "../../src/server/ai/naming-brain/protocol";
import { createNamingReferenceReader } from "../../src/server/ai/naming-brain/source-reader";
import { createOwnerNamingExecutor, OWNER_NAMING_FUNCTIONS } from "../../worker/account-enrollment/naming-runtime";
import { normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { ownerWorkerRole } from "../../worker/account-enrollment/configuration";
import { brainRpc, installBrainFixture, initialIntent, seedBrainFixture, brainPreferences, attestBrainPreferences } from "./naming-brain-fixture";
import { enableHostedNamingFixture } from "./hosted-naming-fixture";
import { createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { evidenceDirectorOutput } from "../fixtures/naming-evidence-plan";

const approaches = ["classical_roots", "other_languages", "people_places", "stories_culture"] as const;
const referenceUrl = "https://en.wikipedia.org/wiki/Synthetic_fixture";
const referenceText = "An explicitly fictional reference passage supports the imaginary fixture attribution.";
type Session = { request: NamingStageRequest; wire: ManagedCreateRequest; id: string; turnId: string; agentId: string; terminal: boolean;
  attempt: number; items: Record<string, unknown>[]; controller?: ReadableStreamDefaultController<Uint8Array>; reply?: { status: string; sourceKey: string; excerpt?: string } };

/** Actual restricted per-owner role, native SDK, reference reader and durable
 * hosted SQL. Only provider HTTP/DNS/page/model content are inert fixtures. This
 * does not assert production artifact/TLS/enrollment qualification. */
async function fixture(db: TestDatabase, mode: "sourced" | "missing" | "irrelevant") {
  const project = await seedBrainFixture(db), policy = createNamingBrainPolicy("gpt-6-luna"), workerId = "synthetic-enrolled-naming", deploymentId = "dpl_syntheticOwnerNaming";
  await brainRpc(db, "save_naming_preferences", [project, 1, { ...brainPreferences, approaches }]); await attestBrainPreferences(db);
  const role = ownerWorkerRole("naming", OWNER_A);
  await db.exec(`create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4; grant usage on schema public to ${role}`);
  for (const signature of OWNER_NAMING_FUNCTIONS) {
    const exists = (await db.query<{ found: boolean }>("select to_regprocedure($1) is not null found", [signature])).rows[0]!.found;
    if (exists) await db.exec(`grant execute on function ${signature} to ${role}`);
  }
  await db.query("update fluid_private.naming_brain_pilots set role_name=$2,role_oid=(select oid from pg_roles where rolname=$2),deployment_id=$3,policy=$4,worker_id=null,ready_until=null where owner_id=$1", [OWNER_A, role, deploymentId, JSON.stringify(policy)]);
  await enableHostedNamingFixture(db);
  const asWorker = async <T>(work: () => Promise<T>) => { await db.exec(`set session authorization ${role}`); try { return await work(); } finally { await db.exec("set session authorization postgres"); } };
  let generation = 0, pageReads = 0, submits = 0, ordinal = 0, researchSaved = false, directorSaved = false;
  const requests = new Map<string, NamingStageRequest>(), sessions = new Map<string, Session>(), creates: string[] = [], dispatchOrder: string[] = [];
  const encoder = new TextEncoder();
  const emit = (session: Session, event: Record<string, unknown>) => session.controller!.enqueue(encoder.encode(`data: ${JSON.stringify({ ...event, event_id: `synthetic-event-${++ordinal}` })}\n\n`));
  const turn = (session: Session) => ({ id: session.turnId, session_id: session.id, agent_id: session.agentId, subagent_id: null, object: "agent.session.turn", status: session.terminal ? "completed" : "waiting", error: null, usage: null, created_at: 1, started_at: 1, completed_at: session.terminal ? 2 : null });
  const sessionBody = (session: Session, required = true) => ({ id: session.id, object: "agent.session", agent: { ...session.wire.agent, id: session.agentId }, environment: session.wire.environment, metadata: session.wire.metadata,
    status: session.terminal ? "idle" : required && session.request.role === "researcher" ? "requires_action" : "running", required_actions: !session.terminal && required && session.request.role === "researcher" ? [{ type: "function_call", name: "read_reference", call_id: `fixture-read-${session.attempt}`, turn_id: session.turnId, arguments: { url: `${referenceUrl}_${session.attempt}` } }] : [], usage: null });
  const emitReference = (session: Session) => {
    const url = `${referenceUrl}_${session.attempt}`, offset = session.items.length;
    const web = { id: `fixture-web-${session.attempt}`, type: "web_search_call", status: "completed", turn_id: session.turnId, action: { type: "open_page", url } };
    const read = { id: `fixture-read-item-${session.attempt}`, type: "function_call", status: "in_progress", turn_id: session.turnId, name: "read_reference", call_id: `fixture-read-${session.attempt}`, arguments: JSON.stringify({ url }) };
    session.items.push(web, read); emit(session, { type: "agent.session.turn.item.done", session_id: session.id, turn_id: session.turnId, output_index: offset, item: web }); emit(session, { type: "agent.session.turn.item.added", session_id: session.id, turn_id: session.turnId, output_index: offset + 1, item: read }); emit(session, { type: "agent.session.requires_action", session: sessionBody(session) });
  };
  const output = (session: Session): NamingModelOutput => {
    const input = session.request.input;
    if (input.role === "researcher") return { role: "researcher", territories: [{ territoryId: "reference", title: "Synthetic reference", direction: "Explore the actually retained fixture passage.", sourceKeys: [session.reply!.sourceKey] }, { territoryId: "contrast", title: "Contrasts", direction: "Vary imagery and sounds.", sourceKeys: [] }],
      facts: session.reply!.status === "retrieved" ? [{ claimKey: "fixture-fact", statement: session.reply!.excerpt!, sourceKeys: [session.reply!.sourceKey], status: "unverified" }] : [], interpretations: [], uncertainties: session.reply!.status === "retrieved" ? ["The first observed reference returned no passage; a second allowed read supplied the retained text."] : ["Both observed reference requests returned no retained passage."] };
    if (input.role === "director") return evidenceDirectorOutput(session.request, mode === "missing" ? [...approaches] : mode === "irrelevant" ? ["classical_roots"] : []);
    if (input.role === "creator") return { role: "creator", assignmentKey: input.assignment.assignmentKey, candidates: Array.from({ length: input.assignment.targetCount }, (_, index) => ({ candidateKey: `candidate-${index}`, value: `Synthetic${session.request.providerCallKey.slice(4, 7)}Name${index}`, primaryApproach: input.assignment.primaryApproach, additionalApproaches: [], territoryId: input.assignment.territoryId, constructionKey: input.assignment.constructionKey, rationale: "An explicitly fictional attribution fixture.", caution: null,
      claims: [{ claimKey: "fixture-attribution", requirement: "primary_approach", statement: input.assignment.sources[0]!.excerpt!, sourceKeys: input.assignment.sourceKeys, status: "unverified" }] })) };
    if (input.role === "curator") return { role: "curator", annotations: [], gaps: [] };
    const assignments = new Map(input.review.artifacts.map(row => [row.artifactKey, row.assignmentKey]));
    return { role: "verifier", findings: input.review.candidates.flatMap(candidate => candidate.claims.map(claim => ({ assignmentKey: assignments.get(candidate.artifactKey)!, candidateKey: candidate.candidateKey, claimKey: claim.claimKey, status: "supported", supportedWording: claim.statement, sourceKeys: claim.sourceKeys,
      evidence: [{ sourceKey: claim.sourceKeys[0]!, start: 0, end: referenceText.length, quote: referenceText }], supportsPrimaryApproach: true, explanation: "Independent fixture Verifier quotes the exact acquired passage." }))) };
  };
  const complete = (session: Session) => {
    if (session.request.role === "researcher") for (const [index, item] of session.items.entries()) if (item.type === "function_call" && item.status !== "completed") { session.items[index] = { ...item, status: "completed" }; emit(session, { type: "agent.session.turn.item.done", session_id: session.id, turn_id: session.turnId, output_index: index, item: session.items[index] }); }
    const item = { id: `final_${session.id}`, type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: session.turnId, content: [{ type: "output_text", text: JSON.stringify(output(session)) }] };
    session.items.push(item); emit(session, { type: "agent.session.turn.item.done", session_id: session.id, turn_id: session.turnId, output_index: session.items.length - 1, item });
    session.terminal = true; emit(session, { type: "agent.session.turn.completed", session_id: session.id, turn_id: session.turnId, turn: turn(session) }); session.controller!.close();
  };
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-never-live-key", localPrototype: true, fetch: async (incoming, init) => {
    const outgoing = new Request(incoming, init), url = new URL(outgoing.url), path = url.pathname;
    expect(url.origin).toBe("https://api.openai.com");
    if (outgoing.method === "POST" && path === "/v1/agents/sessions") {
      const wire = await outgoing.json() as ManagedCreateRequest, request = requests.get(wire.metadata!.embel_call!)!;
      expect(request).toBeDefined(); expect(wire).toEqual(buildNamingManagedRequest(request)); expect(wire).not.toHaveProperty("spend_control");
      expect(request.input.snapshot.ownerId).toBe(OWNER_A); expect(request.policy.progressiveContractVersion).toBe(5);
      if (request.role === "researcher") { expect(wire.agent!.instructions).toContain("Do not stop after one or two attempts"); expect(wire.agent!.instructions).toContain("choose another relevant allowed reference"); }
      if (request.input.role === "creator") { expect(researchSaved).toBe(true); expect(directorSaved).toBe(true); expect(request.input.assignment.sources.every(source => source.evidenceStatus === "retrieved")).toBe(true); expect(request.input.assignment.sourceKeys.length).toBeGreaterThan(0); }
      creates.push(request.providerCallKey); dispatchOrder.push(request.role);
      const count = sessions.size + 1, session: Session = { request, wire, id: `sess_owner_${count}`, turnId: `turn_owner_${count}`, agentId: `agent_owner_${count}`, terminal: false, attempt: 1, items: [] }; sessions.set(session.id, session);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        session.controller = controller; emit(session, { type: "agent.session.created", session: sessionBody(session, false) }); emit(session, { type: "agent.session.turn.created", session_id: session.id, turn_id: session.turnId, turn: turn(session) });
        if (request.role !== "researcher") { complete(session); return; }
        emitReference(session);
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    const session = sessions.get(path.split("/")[4]!)!; if (!session) throw Error("Unexpected inert SDK session");
    if (outgoing.method === "POST") { const body = await outgoing.json() as { events: { type: string; output?: string; call_id?: string }[] }; if (body.events[0]?.type !== "agent.session.input.tool_result") return new Response(null, { status: 202 });
      expect(body.events[0]!.call_id).toBe(`fixture-read-${session.attempt}`); session.reply = JSON.parse(body.events[0]!.output!); submits++;
      if (session.attempt === 1) { expect(session.reply!.status).toBe("unavailable"); const index = session.items.findIndex(item => item.call_id === "fixture-read-1"); session.items[index] = { ...session.items[index], status: "completed" }; emit(session, { type: "agent.session.turn.item.done", session_id: session.id, turn_id: session.turnId, output_index: index, item: session.items[index] }); session.attempt = 2; emitReference(session); }
      else complete(session); return new Response(null, { status: 202 }); }
    if (path.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
    return Response.json(path.endsWith("/items") ? { data: session.items, has_more: false } : path.endsWith("/turns") ? { data: [turn(session)], has_more: false } : path.endsWith(`/${session.turnId}`) ? turn(session) : sessionBody(session));
  } });
  const reader = createNamingReferenceReader({ localPrototype: true, resolveHost: async () => [{ address: "93.184.216.34", family: 4 }], requestPage: async () => { pageReads++; return mode === "missing" || pageReads === 1 ? new Response("Fixture reference unavailable", { status: 404 }) : new Response(referenceText, { headers: { "content-type": "text/plain; charset=utf-8" } }); } });
  const assertEnrollment = async () => { const result = await db.query<{ role: string }>("select session_user::text role"); expect(result.rows[0]!.role).toBe(role); };
  const executor: ReturnType<typeof createOwnerNamingExecutor> = createOwnerNamingExecutor({ database: db, ownerId: OWNER_A, deploymentId, workerId, apiKey: "synthetic-never-live-key", protocol, referenceReader: reader,
    authority: () => ({ workerId, generation }), assertEnrollment, assertReady: async () => { const status = await executor.store.reportWorkerStatus(policy, workerId, generation); if (!status.leader || !status.ready) throw Error("Actual SQL readiness refused"); } });
  const save = executor.store.saveProgressiveCallPlan.bind(executor.store);
  executor.store.saveProgressiveCallPlan = async (job, phase, planned) => { await save(job, phase, planned); for (const request of planned) requests.set(request.providerCallKey, request); };
  const artifact = executor.store.saveArtifact.bind(executor.store);
  executor.store.saveArtifact = async (job, value) => { await artifact(job, value); if (value.output.role === "researcher") researchSaved = true; if (value.output.role === "director") { expect(value.output).toHaveProperty("planVersion", 2); if (!("planVersion" in value.output)) throw Error("Missing evidence-aware plan");
    for (const approach of approaches) if (!value.output.unavailableApproaches.some(row => row.approach === approach)) expect(value.output.assignments.filter(row => row.primaryApproach === approach).reduce((sum, row) => sum + row.targetCount, 0)).toBeGreaterThanOrEqual(5); directorSaved = true; } };
  await asWorker(async () => { const status = await executor.store.reportWorkerStatus(policy, workerId, null); expect(status.leader).toBe(true); generation = status.generation!; await executor.store.attestPendingPreferences(); });
  const intent = { ...initialIntent(`synthetic-owner-${mode}`), expectedPreferencesVersion: 2 };
  await brainRpc(db, "ensure_hosted_naming_brain_run", [project, intent]);
  return { project, role, executor, asWorker, creates, requests, dispatchOrder, counts: () => ({ pageReads, submits }), mode };
}

describe("per-owner hosted Naming executor with actual SDK source acquisition", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 60_000);
  afterAll(async () => { await db?.close(); });
  it.each(["sourced", "missing", "irrelevant"] as const)("keeps owned, uncapped v5 planning and honest coverage for %s references", async mode => {
    const f = await fixture(db, mode);
    try {
      await expect(brainRpc(db, "get_naming_feed", [f.project], OWNER_B)).rejects.toThrow("not_found");
      const state = await f.asWorker(() => f.executor.runJob(new AbortController().signal));
      expect(state).toBe(mode === "sourced" ? "succeeded" : "failed");
      expect(f.counts()).toEqual({ pageReads: 2, submits: 2 });
      const feed = await brainRpc<{ entries: unknown[]; activeRun: { fulfillment: { coverageSatisfied: boolean } } }>(db, "get_naming_feed", [f.project]);
      expect(feed.entries).toHaveLength(mode === "sourced" ? 100 : mode === "missing" ? 0 : 95);
      expect(feed.activeRun.fulfillment.coverageSatisfied).toBe(mode === "sourced");
      expect(f.dispatchOrder.slice(0, 2)).toEqual(["researcher", "director"]);
      if (mode === "missing") expect(f.creates).toHaveLength(2);
      if (mode === "irrelevant") expect([...f.requests.values()].some(request => request.input.role === "creator" && request.input.assignment.primaryApproach === "classical_roots")).toBe(false);
      const proposed = [...f.requests.values()].reduce((sum, request) => sum + (request.input.role === "creator" ? request.input.assignment.targetCount : 0), 0);
      expect(proposed).toBe(mode === "sourced" ? 100 : mode === "missing" ? 0 : 95);
      expect(new Set(f.creates).size).toBe(f.creates.length);
      const jobs = (await db.query<{ input: unknown }>("select input from public.jobs where project_id=$1", [f.project])).rows;
      expect(jobs).toHaveLength(1); expect(namingBrainJobInputSchema.parse(normalizeNamingStoredJson(jobs[0]!.input))).toMatchObject({ executionAuthority: "hosted_owner_v1", providerBudgetVersion: 2 });
      expect((await db.query("select count(*)::integer count from public.name_candidates where owner_id=$1", [OWNER_B])).rows).toEqual([{ count: 0 }]);
      expect((await db.query("select count(*)::integer attempts,count(*) filter(where payload#>>'{sourceEvidence,evidenceStatus}'='retrieved')::integer retrieved from fluid_private.naming_brain_provider_records where kind='tool_result'")).rows).toEqual([{ attempts: 2, retrieved: mode === "missing" ? 0 : 1 }]);
    } finally { await db.exec(`drop owned by ${f.role}; drop role ${f.role}`); }
  }, 60_000);
});
