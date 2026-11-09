// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import type { VerifiedAccount } from "../../src/components/workspace/account-session";
const mock = vi.hoisted(() => ({ session: null as (VerifiedAccount | { status: "signed_out"; generation: number }) | null, current: vi.fn(), expire: vi.fn(), navigate: vi.fn(), memory: null as ReturnType<typeof createNamingBrainMemory> | null }));
vi.mock("../../src/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire, namingBrainDrafts: mock.memory }), AccountStatus: () => createElement("p", {}, "Account verification required") }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.navigate }) }));
import { StandaloneNamesAssistant } from "../../src/components/naming/standalone-names-assistant";
import { STANDALONE_NAMES_MAX_RESPONSE_BYTES, standaloneNamesRequest } from "../../src/components/naming/standalone-names-client";
import { standaloneNamesOverviewSchema, type StandaloneNamesOverview } from "../../src/domain/standalone-names";
import { brief, jobFixture, owner, other, proposal } from "../fixtures/standalone-names";

let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>, overview: StandaloneNamesOverview;
const availability = { status: "available" as const, billingMode: "chatgpt_subscription" as const, policyIdentity: "a".repeat(64), model: "fixture-model", maxNames: 20 as const, maxRequestsPerHour: 20, deadlineMs: 240000 };
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
async function render() { mock.memory!.bind(mock.session?.status === "ready" ? mock.session : null); await act(async () => root.render(createElement(Fragment, null, createElement(StandaloneNamesAssistant)))); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function field(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.session = { status: "ready", userId: owner, generation: 1 }; mock.current.mockImplementation(account => mock.session?.status === "ready" && mock.session.userId === account.userId && mock.session.generation === account.generation); mock.expire.mockReset();
  mock.memory = createNamingBrainMemory({ storage: () => null }); mock.navigate.mockReset();
  overview = { ownerId: owner, availability, jobs: [], hasMore: false };
  fetcher = vi.fn(async (_path, init) => Response.json(init?.method === "POST" ? { job: jobFixture() } : overview)); vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("standalone Names UI and acknowledgement recovery", () => {
  it("keeps earlier names and shortlist choices readable without exposing legacy generation or refinement", async () => {
    const job = { ...jobFixture("succeeded"), likedIndexes: [0], savedIndexes: [0] }; overview.jobs = [job];
    const original = structuredClone(job), clipboard = vi.fn(async () => {}); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    await render(); expect(host.textContent).toContain("Shortlisted"); expect(host.textContent).toContain("Saved");
    await click(button("Copy")); expect(clipboard).toHaveBeenCalledWith(proposal.value);
    await click(button("Shortlist & saved")); expect(host.textContent).toContain(proposal.value);
    expect(button("Generate names")).toBeUndefined(); expect(button("Refine selected names")).toBeUndefined();
    expect(host.querySelector('[type="checkbox"]')).toBeNull(); expect(fetcher.mock.calls.every(([, init]) => init.method === "GET")).toBe(true); expect(job).toEqual(original);
  });
  it.each(["queued", "running"] as const)("cancels an earlier %s request through its existing owned endpoint", async state => {
    const job = jobFixture(state); overview.jobs = [job];
    fetcher.mockImplementation(async (_path, init) => Response.json(init.method === "POST" ? { job: { ...job, state: state === "queued" ? "cancelled" : "cancel_requested", finishedAt: state === "queued" ? "2026-10-13T12:01:00Z" : null } } : overview));
    await render(); await click(button("Cancel request"));
    const writes = fetcher.mock.calls.filter(([, init]) => init.method !== "GET");
    expect(writes).toHaveLength(1); expect(writes[0]![0]).toBe(`/api/names/ai/${job.id}`);
    expect(new Headers(writes[0]![1].headers).get("X-Embel-Account")).toBe(owner);
    expect(JSON.parse(writes[0]![1].body)).toEqual({ action: "cancel" });
    if (state === "running") expect(button("Cancelling…").disabled).toBe(true);
    else expect(button("Cancel request")).toBeUndefined();
    expect(button("Generate names")).toBeUndefined(); expect(mock.navigate).not.toHaveBeenCalled();
  });
  it("keeps an uncertain legacy cancellation actionable and retries only the same job", async () => {
    const job = jobFixture("running"); overview.jobs = [job]; let reject = true;
    fetcher.mockImplementation(async (_path, init) => init.method === "POST"
      ? reject ? Response.json({}, { status: 503 }) : Response.json({ job: { ...job, state: "cancel_requested" } })
      : Response.json(overview));
    await render(); await click(button("Cancel request"));
    expect(host.textContent).toContain("Cancellation could not be confirmed"); expect(button("Cancel request").disabled).toBe(false);
    reject = false; await click(button("Cancel request"));
    const writes = fetcher.mock.calls.filter(([, init]) => init.method === "POST");
    expect(writes.map(([path, init]) => [path, JSON.parse(init.body)])).toEqual(Array(2).fill([`/api/names/ai/${job.id}`, { action: "cancel" }]));
    expect(host.textContent).not.toContain("Cancellation could not be confirmed"); expect(button("Cancelling…").disabled).toBe(true);
  });
  it("rejects a late legacy cancellation receipt after the verified account changes", async () => {
    const job = jobFixture("running"); overview.jobs = [job]; let finish!: (value: Response) => void;
    fetcher.mockImplementation((_path, init) => init.method === "POST" ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json(overview)));
    await render(); await click(button("Cancel request"));
    mock.session = { status: "ready", userId: other, generation: 2 }; overview = { ...overview, ownerId: other, jobs: [] };
    await render(); await act(async () => finish(Response.json({ job: { ...job, state: "cancel_requested" } })));
    expect(host.textContent).not.toContain(brief.description); expect(button("Cancelling…")).toBeUndefined(); expect(mock.expire).not.toHaveBeenCalled();
  });
  it("hides an account immediately and refuses late replies after owner changes", async () => {
    let finish!: (value: Response) => void; fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    await render(); mock.session = { status: "ready", userId: other, generation: 2 }; overview = { ...overview, ownerId: other, jobs: [] };
    await render(); await act(async () => finish(Response.json({ ownerId: owner, availability, jobs: [jobFixture("succeeded")], hasMore: false })));
    expect(host.textContent).not.toContain(proposal.value); expect(mock.expire).not.toHaveBeenCalled();
  });
  it("rejects oversized streamed responses without trusting Content-Length", async () => {
    fetcher.mockResolvedValue(new Response('"' + "x".repeat(STANDALONE_NAMES_MAX_RESPONSE_BYTES) + '"', { headers: { "content-type": "application/json" } }));
    await expect(standaloneNamesRequest("/api/names/ai", z.string(), { signal: new AbortController().signal, expectedOwnerId: owner })).rejects.toMatchObject({ status: 502 });
  });
  it("reads a valid full history page with long Unicode rationales", async () => {
    const jobs = Array.from({ length: 50 }, (_, jobIndex) => {
      const job = jobFixture("succeeded"); job.id = `00000000-0000-4000-8000-${jobIndex.toString().padStart(12, "0")}`;
      job.result!.candidates = Array.from({ length: 20 }, (_, index) => ({ value: `Fixture Name ${index}`, rationale: "界".repeat(800), caution: "界".repeat(400) }));
      return job;
    });
    const body = JSON.stringify({ ...overview, jobs }); expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(2_097_152);
    fetcher.mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    const received = await standaloneNamesRequest("/api/names/ai", standaloneNamesOverviewSchema, { signal: new AbortController().signal, expectedOwnerId: owner });
    expect(received.jobs).toHaveLength(50); expect(received.jobs[49]!.result!.candidates).toHaveLength(20);
  });
});
