import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedSlotStorageSession } from "../../worker/shared-storage/session";
import type { SharedSlotLease } from "../../worker/shared-pool/contracts";
const origin = "http://127.0.0.1:54321", actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const uuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function fixture() {
 let now = Date.now(), foreignSession = false, foreignProof = false, redirect = false, activeSession = true, cleanupUnknown = false;
 const slot: SharedSlotLease = { version: 1, lane: "logo", slotId: uuid, instanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", generation: 1,
  leaseToken: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", roleName: "embel_shared_logo_fixture", roleOid: 123, expiresAt: new Date(now + 86_400_000).toISOString() };
 const user = { id: actor, is_anonymous: false, email_confirmed_at: "2026-01-01T00:00:00Z" };
 const fetch = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(raw)); expect(url.origin).toBe(origin); expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
  if (redirect) { const response = Response.json({}); Object.defineProperty(response, "redirected", { value: true }); return response; }
  if (url.pathname === "/auth/v1/token") {
   const claims = { sub: actor, role: "authenticated", aud: "authenticated", iss: `${origin}/auth/v1`, is_anonymous: false,
    session_id: foreignSession ? uuid : sid, exp: Math.floor(now / 1000) + 3600 };
   const token = [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url"), "fixture"].join(".");
   return Response.json({ access_token: token, refresh_token: "fixture-memory-refresh", expires_in: 3600, token_type: "bearer", user });
  }
  if (url.pathname === "/auth/v1/user") return Response.json(user);
  if (url.pathname === "/auth/v1/logout") { expect(url.searchParams.get("scope")).toBe("local"); activeSession = false; return new Response(null, { status: 204 }); }
  if (url.pathname === "/rest/v1/rpc/shared_logo_storage_session_closed") return Response.json(!activeSession && !cleanupUnknown);
  if (url.pathname === "/rest/v1/rpc/shared_logo_storage_session") return Response.json({ version: 1, slotId: slot.slotId, instanceId: slot.instanceId,
   generation: foreignProof ? 99 : slot.generation, roleName: slot.roleName, roleOid: slot.roleOid, authUserId: actor, sessionId: sid });
  throw Error("Unexpected inert Auth route");
 });
 return { slot, fetch, input: { targetOrigin: origin, publishableKey: "sb_publishable_fixture", authUserId: actor, email: "fixed-slot@example.test", password: "fixture-memory-password", slot: () => slot },
  now: () => now, advance() { now += 3_500_000; }, foreignSession() { foreignSession = true; }, foreignProof() { foreignProof = true; }, redirect() { redirect = true; }, cleanupUnknown() { cleanupUnknown = true; } };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("fixed-slot ordinary Auth session (HTTP mocks only; no live credentials)", () => {
 it("uses normal password signin and rotates refresh tokens within one verified Auth session, without admin calls", async () => {
  const f = fixture(), session = await createSharedSlotStorageSession(f.input, { fetch: f.fetch, now: f.now });
  expect(session.sessionId).toBe(sid); await session.tokenProvider(); f.advance(); await Promise.all([session.tokenProvider(), session.tokenProvider()]);
  expect(f.fetch.mock.calls.filter(([url]) => String(url).includes("grant_type=password"))).toHaveLength(1);
  expect(f.fetch.mock.calls.filter(([url]) => String(url).includes("grant_type=refresh_token"))).toHaveLength(1);
  expect(f.fetch.mock.calls.some(([url]) => String(url).includes("/admin/"))).toBe(false);
  await session.close(); await expect(session.tokenProvider()).rejects.toThrow();
  expect(f.fetch.mock.calls.filter(([url]) => String(url).includes("/logout?scope=local"))).toHaveLength(1);
 });
 it("never falls back to password signin if a refreshed token changes session identity", async () => {
  const f = fixture(), session = await createSharedSlotStorageSession(f.input, { fetch: f.fetch, now: f.now }); f.foreignSession(); f.advance();
  await expect(session.tokenProvider()).rejects.toThrow(); expect(f.fetch.mock.calls.filter(([url]) => String(url).includes("grant_type=password"))).toHaveLength(1);
  await expect(session.close()).rejects.toThrow(); // A foreign cached SID cannot prove original-session cleanup.
 });
 it.each(["proof", "redirect"])("rejects %s during fixed-slot qualification", async mode => {
  const f = fixture(); if (mode === "proof") f.foreignProof(); else f.redirect();
  await expect(createSharedSlotStorageSession(f.input, { fetch: f.fetch, now: f.now })).rejects.toThrow("Shared slot Storage is unavailable");
 });
 it("fences a retained session when slot instance/generation changes", async () => {
  const f = fixture(), session = await createSharedSlotStorageSession(f.input, { fetch: f.fetch, now: f.now }); f.slot.generation++;
  await expect(session.tokenProvider()).rejects.toThrow(); await session.close();
 });
 it("refuses Auth-admin/service-role keys rather than treating them as a public key", async () => {
  const f = fixture(); await expect(createSharedSlotStorageSession({ ...f.input, publishableKey: "fixture-service-role-key" }, { fetch: f.fetch })).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
 });
 it("reports cleanup uncertainty instead of inferring revocation from local disposal", async () => {
  const f = fixture(), session = await createSharedSlotStorageSession(f.input, { fetch: f.fetch, now: f.now }); f.cleanupUnknown();
  await expect(session.close()).rejects.toThrow("Shared slot Storage is unavailable"); await expect(session.tokenProvider()).rejects.toThrow();
 });
 it("uses only same-session cleanup refresh when the SDK's actual clock sees an expired idle token", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); const base = Date.now(), f = fixture();
  const session = await createSharedSlotStorageSession(f.input, { fetch: f.fetch });
  vi.setSystemTime(base + 7_200_000); f.advance(); f.advance(); f.slot.expiresAt = new Date(base - 1).toISOString();
  await session.close(); await expect(session.tokenProvider()).rejects.toThrow();
  expect(f.fetch.mock.calls.filter(([url]) => String(url).includes("grant_type=password"))).toHaveLength(1);
  expect(f.fetch.mock.calls.filter(([url]) => String(url).includes("grant_type=refresh_token"))).toHaveLength(1);
  expect(f.fetch.mock.calls.filter(([url]) => String(url).includes("logout?scope=local"))).toHaveLength(1);
 });
});
