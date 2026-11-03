// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CandidateAvailability } from "@/components/naming/candidate-availability";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const account: VerifiedAccount = { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 };
const isCurrent = (current: VerifiedAccount) => current.userId === account.userId && current.generation === account.generation;
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ isCurrent }) }));
const caps = { ownerId: account.userId, domains: "rdap", youtube: true, euipo: true };
const now = Date.parse("2026-11-03T12:00:00Z"), at = new Date(now).toISOString();
let root: Root | null, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.useFakeTimers(); vi.setSystemTime(now);
});
afterEach(async () => { if (root) await act(() => root!.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = () => act(() => root!.render(<CandidateAvailability name="River Coil" account={account} />));
const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text)!;
const click = (text: string) => act(() => { button(text).click(); });

it("checks the exact edited domain on demand and withdraws a stale registration result", async () => {
  const check = { id: "check", provider: "Public registry RDAP", domain: "rivercoil.net", availability: "taken", checkedAt: at,
    validUntil: new Date(now + 60000).toISOString(), evidenceReference: "fixture", sourceUrl: "https://registry.example/rivercoil.net" };
  const lookup = vi.fn(async (_path: string, init: RequestInit) => Response.json(init.method === "GET" ? caps : {
    ownerId: account.userId, result: { status: "domain", check, quote: null },
  }));
  vi.stubGlobal("fetch", lookup); await render();
  expect(lookup.mock.calls.map(([, init]) => init.method)).toEqual(["GET"]);
  const input = host.querySelector("input")!;
  expect(input.value).toBe("rivercoil.com");
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "RIVERCOIL.NET");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Check domain");
  const [, init] = lookup.mock.calls[1]!;
  expect(init.headers).toMatchObject({ "X-Embel-Account": account.userId });
  expect(JSON.parse(String(init.body))).toEqual({ tool: "domains", domain: "rivercoil.net" });
  expect(host.textContent).toContain("rivercoil.net · Taken");
  expect(host.querySelector('a')?.getAttribute("href")).toBe(check.sourceUrl);
  await act(() => vi.advanceTimersByTimeAsync(60002));
  expect(host.textContent).toContain("Availability unknown"); expect(lookup).toHaveBeenCalledTimes(2);
});

it("aborts a pending lookup on tab change or close and ignores its late response", async () => {
  const pending: { signal: AbortSignal; finish: () => void }[] = [];
  const lookup = vi.fn(async (_path: string, init: RequestInit) => init.method === "GET" ? Response.json(caps) :
    new Promise<Response>(resolve => pending.push({ signal: init.signal!, finish: () => resolve(Response.json({ ownerId: account.userId, result: {status:"failed",code:"timeout",retryAfterSeconds:null} })) })));
  vi.stubGlobal("fetch", lookup); await render(); await click("Check domain");
  await click("Handles"); expect(pending[0]!.signal.aborted).toBe(true);
  await act(() => pending[0]!.finish()); expect(host.querySelector('[role="alert"]')).toBeNull();
  await click("Check handle"); await act(() => root!.unmount()); root = null;
  expect(pending[1]!.signal.aborted).toBe(true);
});

it("offers official manual checks when capabilities are unavailable without issuing a lookup", async () => {
  const lookup = vi.fn(async () => Response.json({ ownerId: account.userId, domains: "unavailable", youtube: false, euipo: false }));
  vi.stubGlobal("fetch", lookup); await render(); expect(button("Check domain").disabled).toBe(true);
  expect(host.querySelector("a")?.href).toContain("rivercoil.com");
  await click("Handles"); expect(button("Check handle").disabled).toBe(true);
  expect(host.querySelector("a")?.href).toBe("https://www.youtube.com/@rivercoil");
  await click("Trademarks"); expect(button("Search trademarks").disabled).toBe(true);
  expect(host.querySelector("a")?.href).toBe("https://euipo.europa.eu/eSearch/"); expect(lookup).toHaveBeenCalledOnce();
});
