// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Pool } from "pg";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ auth: vi.fn(), account: { status: "ready" as const, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 }, current: vi.fn(() => true), expire: vi.fn(), memory: null as ReturnType<typeof createNamingBrainMemory> | null }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mock.auth }));
vi.mock("../../src/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.account, isCurrent: mock.current, expire: mock.expire, namingBrainDrafts: mock.memory }), AccountStatus: () => createElement("p", {}, "Account verification required") }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { StandaloneNamesAssistant } from "../../src/components/naming/standalone-names-assistant";
import { GET, POST } from "../../src/app/api/names/ai/route";
import { PATCH, POST as cancel } from "../../src/app/api/names/ai/[jobId]/route";
import { createStandaloneNamesDatabase } from "../database/standalone-ai-names-fixture";
import { asRole, asSubscriptionWorker, resetFixture, type TestDatabase } from "../database/local-supabase";
import { runOneStandaloneNamesJob } from "../../worker/standalone-names";
import type { ChatGPTTransport } from "../../src/server/ai/chatgpt-transport";
import { owner, policy, proposal, brief } from "../fixtures/standalone-names";

describe("retained Names API → durable SQL → worker → read-only history (synthetic provider only)", () => {
  let db: TestDatabase, root: Root, host: HTMLDivElement;
  // PGlite has one session. Keep route polling and the worker's synthetic
  // SET ROLE boundary separate, as independent real connections would be.
  let boundary: Promise<unknown> = Promise.resolve();
  const isolated = <T,>(run: () => Promise<T>) => {
    const task = boundary.then(run); boundary = task.catch(() => {}); return task;
  };
  beforeAll(async () => {
    const started = Date.now();
    const stage = (message: string) => console.info(`[standalone Names synthetic fixture +${Date.now() - started}ms] ${message}`);
    db = await createStandaloneNamesDatabase(stage); await resetFixture(db);
    stage("seeding owner-bound synthetic runtime");
    await db.exec("grant execute on function public.report_standalone_names_ready(jsonb),public.claim_standalone_names(jsonb),public.pulse_standalone_names(uuid,uuid,boolean,text),public.finish_standalone_names(uuid,uuid,text,jsonb,text,text) to fixture_subscription_worker_a");
    await asSubscriptionWorker(db, owner, async () => {
      await db.query("select public.configure_subscription_runtime($1,'naming.generate',$2::jsonb,true)", [owner, JSON.stringify(policy)]);
      await db.query("select public.report_subscription_worker_ready($1,$2,'naming.generate',$3::jsonb,90)", [owner, policy.registrationId, JSON.stringify(policy)]);
    });
    await db.query("insert into fluid_private.standalone_names_runtime(owner_id,enabled) values($1,true)", [owner]);
    await asSubscriptionWorker(db, owner, () => db.query("select public.report_standalone_names_ready($1::jsonb)", [JSON.stringify(policy)]));
    mock.auth.mockResolvedValue({ userId: owner, client: { rpc: async (name: string, args: Record<string, unknown>) => isolated(() => asRole(db, "authenticated", owner, async () => {
      try { const value = await db.query<{ value: unknown }>(`select public.${name}(${Object.keys(args).map((key, index) => `${key} => $${index + 1}`).join(",")}) value`, Object.values(args)); return { data: value.rows[0]!.value, error: null }; }
      catch (error) { return { data: null, error }; }
    })) } });
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3106"); vi.stubEnv("FLUID_RUNTIME", "local"); vi.stubEnv("VERCEL", ""); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
      const request = new Request(`http://127.0.0.1:3106${path}`, { ...options, headers: { ...options.headers, origin: "http://127.0.0.1:3106" } });
      if (options.method === "GET") return GET(request);
      if (path === "/api/names/ai") return POST(request);
      const context = { params: Promise.resolve({ jobId: path.split("/").at(-1)! }) };
      return options.method === "PATCH" ? PATCH(request, context) : cancel(request, context);
    }));
    mock.memory = createNamingBrainMemory({ storage: () => null }); mock.memory.bind(mock.account);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    stage("UI/API/worker fixture ready");
  // WASM compilation plus the historical SQL replay can exceed 90s on the
  // shared test VM. This allowance applies only to fixture setup.
  }, 180000);
  afterAll(async () => { if (root) await act(async () => root.unmount()); host?.remove(); await boundary; vi.unstubAllGlobals(); vi.unstubAllEnvs(); await db?.close(); });
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
  async function waitUntil(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); expect(test()).toBe(true); }
  async function click(element: HTMLElement) { await act(async () => element.click()); await waitUntil(() => !button("Refresh earlier requests").disabled); }
  const legacyRequest = (path: string, method: string, body: unknown) => new Request(`http://127.0.0.1:3106${path}`, { method, headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:3106", "X-Embel-Account": owner }, body: JSON.stringify(body) });
  it("preserves legacy results and saved refinements while the history UI admits no new requests", async () => {
    // Seed the historical entry through its existing API; new brief entry now uses canonical Project Naming.
    const readiness = await (await GET(new Request("http://127.0.0.1:3106/api/names/ai"))).json();
    expect(readiness.availability.status).toBe("available");
    const created = await POST(new Request("http://127.0.0.1:3106/api/names/ai", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:3106", "X-Embel-Account": owner }, body: JSON.stringify({ brief, refinement: null, acceptSubscriptionUsage: true, acceptedPolicyIdentity: readiness.availability.policyIdentity, idempotencyKey: "synthetic-legacy-naming-history" }) }));
    expect(created.status).toBe(202);
    await act(async () => root.render(createElement(StandaloneNamesAssistant))); await waitUntil(() => Boolean(button("Refresh earlier requests")));
    expect((await db.query("select state from public.standalone_name_jobs")).rows).toEqual([{ state: "queued" }]);
    let dispatches = 0;
    const transport: ChatGPTTransport = { listModels: vi.fn(), streamResponse: async (request, options) => {
      await options.beforeDispatch?.(); dispatches++;
      if (dispatches === 2) expect(JSON.parse(request.input[0]!.content).refinement).toEqual({ names: [proposal.value], instruction: "Shorter and softer" });
      const text = JSON.stringify({ candidates: [{ ...proposal, value: dispatches === 1 ? proposal.value : "Fixture Kiln" }] }); await options.onTextDelta?.(text);
      return { status: "completed", accountId: policy.registrationId, responseId: `fixture-response-${dispatches}`, requestId: null, partialText: text,
        response: { id: `fixture-response-${dispatches}`, status: "completed", model: policy.model, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] } };
    } };
    async function run() {
      return isolated(() => asSubscriptionWorker(db, owner, () => runOneStandaloneNamesJob({ database: db as unknown as Pick<Pool, "query">, ownerId: owner, policy, transport,
        signal: new AbortController().signal, assertReady: async () => {} })));
    }
    expect(await run()).toBe(true); await click(button("Refresh earlier requests")); expect(host.textContent).toContain(proposal.value);
    // Historical mutations remain independently covered through their existing
    // API; the ordinary Names UI no longer exposes that generation path.
    const firstJob = (await db.query<{ id: string }>("select id from public.standalone_name_jobs")).rows[0]!.id;
    const retained = await PATCH(legacyRequest(`/api/names/ai/${firstJob}`, "PATCH", { candidateIndex: 0, liked: true, saved: true }), { params: Promise.resolve({ jobId: firstJob }) });
    expect(retained.status).toBe(200);
    const refined = await POST(legacyRequest("/api/names/ai", "POST", { brief, refinement: { sourceJobId: firstJob, candidateIndexes: [0], instruction: "Shorter and softer" }, acceptSubscriptionUsage: true, acceptedPolicyIdentity: readiness.availability.policyIdentity, idempotencyKey: "synthetic-legacy-naming-refinement" }));
    expect(refined.status).toBe(202);
    expect(await run()).toBe(true); await click(button("Refresh earlier requests"));
    const history = host.querySelector<HTMLSelectElement>("select")!;
    const nextId = (await refined.json()).job.id;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(history, nextId); history.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.textContent).toContain("Fixture Kiln"); expect(button("Generate names")).toBeUndefined(); expect(button("Refine selected names")).toBeUndefined();
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    const jobs = (await db.query<{ state: string; depth: number; liked_indexes: number[]; saved_indexes: number[] }>("select state,depth,liked_indexes,saved_indexes from public.standalone_name_jobs order by created_at")).rows;
    expect(jobs).toEqual([{ state: "succeeded", depth: 0, liked_indexes: [0], saved_indexes: [0] }, { state: "succeeded", depth: 1, liked_indexes: [], saved_indexes: [] }]);
    expect((await db.query("select count(*)::integer n from public.projects")).rows).toEqual([{ n: 0 }]); expect(dispatches).toBe(2);
  }, 30000);
});
