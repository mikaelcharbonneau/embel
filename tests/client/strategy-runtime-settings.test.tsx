// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolWorkspace } from "@/components/workspace/tool-workspace";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount | { status: "checking" | "signed_out" | "unavailable" | "error"; generation: number },
  current: vi.fn(), expire: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire }), AccountStatus: () => null }));
vi.mock("@/components/workspace/local-drafts", async importOriginal => ({ ...await importOriginal<object>(), useLocalDrafts: () => ({ drafts: [], storage: "available" }) }));
vi.mock("@/components/workspace/recorded-usage", () => ({ RecordedUsageSection: () => null }));
vi.mock("@/components/workspace/local-chatgpt-settings", () => ({ LocalChatGPTSettings: ({ enabled }: { enabled: boolean }) => enabled ? createElement("div", null, "Existing local ChatGPT controls") : null }));

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ready = () => ({ status: "available", operations: [{ operation: "strategy.reformulate", billingMode: "openai_api", maximumCostMicrousd: 122880 }] });
const unavailable = (reason = "worker_unavailable") => ({ status: "unavailable", operations: [], reason });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>, runtime: unknown;
async function render(localRuntimeEnabled = false) {
  await act(async () => root.render(createElement(ToolWorkspace, { tool: "settings", localRuntimeEnabled })));
  await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][id="settings-tab-ai"]')!.click());
}
function statusText() { return host.querySelector('[aria-label="Text and strategy status"]')?.textContent ?? ""; }
async function refreshStatus() { await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Check text status")!.click()); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.current.mockReset().mockImplementation((value: VerifiedAccount) => mock.session.status === "ready" && value.userId === mock.session.userId && value.generation === mock.session.generation);
  mock.expire.mockReset(); runtime = ready();
  fetcher = vi.fn(async (path: string) => { if (path !== "/api/strategy") throw new Error(`Unexpected request ${path}`); return Response.json({ availability: runtime }); });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { for (const [path, init] of fetcher.mock.calls) { expect(path).toBe("/api/strategy"); expect(init.method).toBe("GET"); expect(init.body).toBeUndefined(); } await act(async () => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Settings text runtime status", () => {
  // Reintroducing the local-only hardcoded status must fail this mounted integration check.
  it("reports owner-scoped hosted response availability without asserting a live response or enabling other operations", async () => {
    await render();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/strategy", expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }));
    expect(statusText()).toContain("Available for requests");
    expect(statusText()).toContain("Response");
    expect(statusText()).toContain("OpenAI API");
    expect(statusText()).toContain("$0.12288 USD");
    expect(statusText()).toContain("not proof of a completed live response");
    expect(statusText()).not.toContain("Competitor research");
    expect(statusText()).not.toContain("GPT-6.1"); // The contract does not expose model identity.
    expect(host.textContent).not.toContain("Text and image generation are not connected");
    expect(host.textContent).not.toContain("Competitor research, domains");
    expect(host.textContent).toContain("Image availability is checked separately in Identity");
  });
  it.each(["signed_out", "checking", "unavailable", "error"] as const)("does not query private readiness or claim a connection while %s", async status => {
    mock.session = { status, generation: 2 }; await render();
    expect(fetcher).not.toHaveBeenCalled();
    expect(statusText()).toContain(status === "signed_out" ? "Sign in to Embel" : status === "checking" ? "Checking your Embel account" : "Verify your Embel account");
    expect(statusText()).not.toContain("Available for requests"); expect(statusText()).not.toContain("$0.12288");
  });
  it.each([
    ["runtime_disabled", "Text requests are not enabled for this account"],
    ["worker_unavailable", "The text worker is not ready"],
    ["budget_unavailable", "The approved text budget is unavailable"],
    ["subscription_unavailable", "The ChatGPT subscription connection is unavailable"],
    ["quota_unavailable", "The current text request limit is unavailable"],
    ["request_unresolved", "A previous request needs review before another can start. Check its status before trying again."],
    ["request_active", "A request is already in progress. Wait for it to finish, then check status."],
  ])("shows the authenticated %s reason without claiming disconnection", async (reason, message) => {
    runtime = unavailable(reason); await render();
    expect(statusText()).toContain(message); expect(statusText()).toContain("Unavailable");
    expect(statusText()).not.toContain("Not connected"); expect(statusText()).not.toContain("Available for requests");
    expect(statusText()).not.toContain("$0.12288");
  });
  it("uses returned subscription billing and operations rather than assuming hosted API billing", async () => {
    runtime = { status: "available", operations: [{ operation: "strategy.competitors", billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64), limits: { maxInputBytes: 131072, maxOutputBytes: 262144, deadlineMs: 240000, maxObservedWebSearchCalls: 2, maxRequestsPerHour: 20, maxQueuedJobs: 3 } }] };
    await render(); expect(statusText()).toContain("Competitor research"); expect(statusText()).toContain("ChatGPT subscription");
    expect(statusText()).not.toContain("OpenAI API"); expect(statusText()).not.toContain("$0.12288");
    expect(statusText()).not.toContain("a".repeat(64)); expect(statusText()).toContain("20 requests/hour");
  });
  it("retains legacy API billing semantics when billingMode is absent", async () => {
    runtime = { status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 10000 }] };
    await render(); expect(statusText()).toContain("OpenAI API"); expect(statusText()).toContain("$0.01 USD");
  });
  it("preserves local subscription controls without adding a hosted status request", async () => {
    await render(true); expect(host.textContent).toContain("Existing local ChatGPT controls");
    expect(fetcher).not.toHaveBeenCalled(); expect(host.querySelector('[aria-label="Text and strategy status"]')).toBeNull();
    expect(host.textContent).not.toContain("Text and image generation are not connected");
  });
  it("keeps readiness pending until an authenticated response arrives", async () => {
    const gate = deferred<Response>(); fetcher.mockReturnValue(gate.promise); await render();
    expect(statusText()).toContain("Checking text availability"); expect(statusText()).not.toContain("Available for requests");
    await act(async () => gate.resolve(Response.json({ availability: ready() })));
    expect(statusText()).toContain("Available for requests");
  });
  it.each(["network", "invalid", "503"])("reports %s failure as unverified status and supports read-only retry", async problem => {
    fetcher.mockImplementationOnce(() => problem === "network" ? Promise.reject(new Error("DO_NOT_DISPLAY_SERVER_DETAIL")) : Promise.resolve(problem === "503" ? new Response("DO_NOT_DISPLAY_SERVER_DETAIL", { status: 503 }) : Response.json({ availability: { status: "available", operations: [] }, secret: "DO_NOT_DISPLAY_SERVER_DETAIL" })));
    await render(); expect(statusText()).toContain("Text status could not be checked");
    expect(statusText()).not.toContain("DO_NOT_DISPLAY"); expect(statusText()).not.toContain("Available for requests");
    await refreshStatus(); expect(statusText()).toContain("Available for requests"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("expires an account rejected by the readiness endpoint", async () => {
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 })); await render();
    expect(mock.expire).toHaveBeenCalledExactlyOnceWith(mock.session); expect(statusText()).not.toContain("Available for requests");
  });
  it("clears prior availability immediately on refresh and replaces it with the fresh reason", async () => {
    await render(); const gate = deferred<Response>(); fetcher.mockReturnValueOnce(gate.promise); await refreshStatus();
    expect(statusText()).toContain("Checking text availability"); expect(statusText()).not.toContain("$0.12288");
    await act(async () => gate.resolve(Response.json({ availability: unavailable("budget_unavailable") })));
    expect(statusText()).toContain("The approved text budget is unavailable"); expect(statusText()).not.toContain("Available for requests");
  });
  it("fences a late response after sign-out", async () => {
    const gate = deferred<Response>(); fetcher.mockReturnValueOnce(gate.promise); await render();
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    mock.session = { status: "signed_out", generation: 2 }; await render(); expect(signal.aborted).toBe(true);
    await act(async () => gate.resolve(Response.json({ availability: ready() })));
    expect(statusText()).toContain("Sign in to Embel"); expect(statusText()).not.toContain("$0.12288");
  });
  it.each(["owner", "generation"])("hides earlier account status and fences late replies after a %s change", async change => {
    const gate = deferred<Response>(); fetcher.mockReturnValueOnce(gate.promise); await render();
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    mock.session = { status: "ready", userId: change === "owner" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : owner, generation: 2 };
    runtime = unavailable("runtime_disabled"); await render(); expect(signal.aborted).toBe(true);
    await act(async () => gate.resolve(Response.json({ availability: ready() })));
    expect(statusText()).toContain("Text requests are not enabled for this account"); expect(statusText()).not.toContain("$0.12288");
  });
  it("bounds a stalled check and rejects a late success after timeout", async () => {
    vi.useFakeTimers(); const gate = deferred<Response>(); fetcher.mockReturnValueOnce(gate.promise); await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect((fetcher.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
    expect(statusText()).toContain("Text status could not be checked");
    await act(async () => gate.resolve(Response.json({ availability: ready() })));
    expect(statusText()).not.toContain("Available for requests");
  });

});
