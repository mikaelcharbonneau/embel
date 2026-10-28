// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let root: Root, host: HTMLDivElement, account: ReturnType<typeof useAccountSession>;
let reads: { path: string; init: RequestInit; resolve: (response: Response) => void }[];
function Probe() { const value = useAccountSession(); useLayoutEffect(() => { account = value; }); return <p>{value.session.status}</p>; }
async function reply(index: number, body: unknown, status = 200) { await act(async () => reads[index]!.resolve(Response.json(body, { status }))); }
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); reads = [];
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("fetch", vi.fn((path: string, init: RequestInit) => new Promise<Response>(resolve => reads.push({ path, init, resolve }))));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AccountSessionProvider><Probe /></AccountSessionProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("preserves the verified session and drafts when enrollment temporarily fails and focus rechecks the same owner", async () => {
  await reply(0, { user: { id: owner }, enrollmentEnabled: true });
  const session = account.session, drafts = account.drafts;
  expect(reads[1]).toMatchObject({ path: "/api/account/enrollment", init: { method: "POST", body: "{}" } });
  await reply(1, {}, 503); expect(account.session).toBe(session); expect(account.drafts).toBe(drafts);
  await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  const sessionRead = reads.findIndex((read, index) => index > 1 && read.path === "/api/session");
  expect(sessionRead).toBeGreaterThan(1); await reply(sessionRead, { user: { id: owner }, enrollmentEnabled: true });
  expect(account.session).toBe(session); expect(account.drafts).toBe(drafts);
  expect(reads.filter(read => read.path === "/api/account/enrollment" && read.init.method === "POST")).toHaveLength(1);
});

it("aborts previous enrollment on an account change and hides its late status", async () => {
  await reply(0, { user: { id: owner }, enrollmentEnabled: true });
  await act(async () => account.refresh());
  expect(reads[1]!.init.signal!.aborted).toBe(true);
  await reply(2, { user: { id: other } });
  await reply(1, { enrollment: { ownerId: owner, generation: 1, status: "ready", updatedAt: "2026-10-27T00:00:00Z", capabilities: { home_attachments: true, identity_transactions: true, strategy: true, naming: true, logo: true } } });
  expect(account.session).toMatchObject({ userId: other }); expect(account.enrollment).toBeUndefined();
  expect(reads).toHaveLength(3);
});
