// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { VerifiedAccount } from "../../src/components/workspace/account-session";
const mock = vi.hoisted(() => ({ session: null as (VerifiedAccount | { status: "signed_out"; generation: number }) | null, current: vi.fn(), expire: vi.fn() }));
vi.mock("../../src/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire }), AccountStatus: () => createElement("p", {}, "Account verification required") }));
import { StandaloneNamesAssistant } from "../../src/components/naming/standalone-names-assistant";
import { STANDALONE_NAMES_MAX_RESPONSE_BYTES, standaloneNamesRequest } from "../../src/components/naming/standalone-names-client";
import { standaloneNamesOverviewSchema, type StandaloneNamesOverview } from "../../src/domain/standalone-names";
import { brief, jobFixture, owner, other, proposal } from "../fixtures/standalone-names";

let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>, overview: StandaloneNamesOverview;
const availability = { status: "available" as const, billingMode: "chatgpt_subscription" as const, policyIdentity: "a".repeat(64), model: "fixture-model", maxNames: 20 as const, maxRequestsPerHour: 20, deadlineMs: 240000 };
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
async function render() { await act(async () => root.render(createElement(StandaloneNamesAssistant))); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function field(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function fillBrief() {
  const fields = host.querySelectorAll<HTMLTextAreaElement>("textarea");
  await field(fields[0]!, brief.description); await field(fields[1]!, brief.direction);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.session = { status: "ready", userId: owner, generation: 1 }; mock.current.mockImplementation(account => mock.session?.status === "ready" && mock.session.userId === account.userId && mock.session.generation === account.generation); mock.expire.mockReset();
  overview = { ownerId: owner, availability, jobs: [], hasMore: false };
  fetcher = vi.fn(async (_path, init) => Response.json(init?.method === "POST" ? { job: jobFixture() } : overview)); vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("standalone Names UI and acknowledgement recovery", () => {
  it("requires explicit plan acceptance and sends the brief directly without a project", async () => {
    await render(); await fillBrief(); expect(button("Generate names").disabled).toBe(true);
    await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!); await click(button("Generate names"));
    const call = fetcher.mock.calls.find(([, init]) => init.method === "POST")!;
    expect(call[0]).toBe("/api/names/ai"); expect(JSON.parse(call[1].body)).toMatchObject({ brief, acceptSubscriptionUsage: true, refinement: null });
    expect(JSON.parse(call[1].body)).not.toHaveProperty("ownerId"); expect(JSON.parse(call[1].body)).not.toHaveProperty("projectId");
    expect(host.textContent).toContain("Waiting for the local worker");
  });
  it("shows configured unavailability without pretending to generate", async () => {
    overview.availability = { status: "unavailable", reason: "local_runtime_required" };
    await render(); await fillBrief(); expect(button("Generate names").disabled).toBe(true); expect(host.textContent).toContain("Hosted generation is not enabled");
    expect(fetcher.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
  it("retains and retries exactly the same request after a lost acknowledgement", async () => {
    fetcher.mockImplementation((_path, init) => init.method === "POST" ? new Promise(() => {}) : Promise.resolve(Response.json(overview)));
    await render(); await fillBrief(); await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!); await click(button("Generate names"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(button("Retry this same request").disabled).toBe(false);
    const first = fetcher.mock.calls.find(([, init]) => init.method === "POST")![1].body;
    fetcher.mockImplementation(async (_path, init) => Response.json(init.method === "POST" ? { job: jobFixture() } : overview));
    await click(button("Retry this same request"));
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST").map(([, init]) => init.body)).toEqual([first, first]);
  });
  it("shortlists, saves, refines selected names and copies actual displayed text", async () => {
    let job = jobFixture("succeeded"); overview.jobs = [job]; const clipboard = vi.fn(async () => {}); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    fetcher.mockImplementation(async (_path, init) => {
      if (init.method === "PATCH") { const value = JSON.parse(init.body); job = { ...job, likedIndexes: value.liked ? [0] : [], savedIndexes: value.saved ? [0] : [] }; return Response.json({ job }); }
      if (init.method === "POST") { const value = JSON.parse(init.body); return Response.json({ job: { ...jobFixture(), depth: 1, refinement: { ...value.refinement, sourceNames: [proposal.value] } } }); }
      return Response.json(overview);
    });
    await render(); await click(button("Shortlist")); expect(button("Shortlisted").getAttribute("aria-pressed")).toBe("true");
    await click(button("Save")); expect(button("Saved").getAttribute("aria-pressed")).toBe("true");
    await click(button("Copy")); expect(clipboard).toHaveBeenCalledWith(proposal.value);
    const choice = [...host.querySelectorAll<HTMLLabelElement>("label")].find(label => label.textContent?.includes("Refine this name"))!.querySelector<HTMLInputElement>("input")!;
    await click(choice); await field(host.querySelectorAll<HTMLTextAreaElement>("textarea")[2]!, "Make it shorter");
    await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!); await click(button("Refine selected names"));
    const body = JSON.parse(fetcher.mock.calls.filter(([, init]) => init.method === "POST").at(-1)![1].body);
    expect(body.refinement).toEqual({ sourceJobId: job.id, candidateIndexes: [0], instruction: "Make it shorter" }); expect(body.refinement).not.toHaveProperty("sourceNames");
  });
  it("hides an account immediately and refuses late replies after owner changes", async () => {
    let finish!: (value: Response) => void; fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    await render(); mock.session = { status: "ready", userId: other, generation: 2 }; overview = { ...overview, ownerId: other, jobs: [] };
    await render(); await act(async () => finish(Response.json({ ownerId: owner, availability, jobs: [jobFixture("succeeded")], hasMore: false })));
    expect(host.textContent).not.toContain(proposal.value); expect(mock.expire).not.toHaveBeenCalled();
  });
  it("rejects oversized streamed responses without trusting Content-Length", async () => {
    fetcher.mockResolvedValue(new Response('"' + "x".repeat(STANDALONE_NAMES_MAX_RESPONSE_BYTES) + '"', { headers: { "content-type": "application/json" } }));
    await expect(standaloneNamesRequest("/api/names/ai", z.string(), { signal: new AbortController().signal })).rejects.toMatchObject({ status: 502 });
  });
  it("reads a valid full history page with long Unicode rationales", async () => {
    const jobs = Array.from({ length: 50 }, (_, jobIndex) => {
      const job = jobFixture("succeeded"); job.id = `00000000-0000-4000-8000-${jobIndex.toString().padStart(12, "0")}`;
      job.result!.candidates = Array.from({ length: 20 }, (_, index) => ({ value: `Fixture Name ${index}`, rationale: "界".repeat(800), caution: "界".repeat(400) }));
      return job;
    });
    const body = JSON.stringify({ ...overview, jobs }); expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(2_097_152);
    fetcher.mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    const received = await standaloneNamesRequest("/api/names/ai", standaloneNamesOverviewSchema, { signal: new AbortController().signal });
    expect(received.jobs).toHaveLength(50); expect(received.jobs[49]!.result!.candidates).toHaveLength(20);
  });
});
