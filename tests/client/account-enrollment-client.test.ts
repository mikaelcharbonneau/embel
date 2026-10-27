// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAccountEnrollmentClient } from "@/components/workspace/account-enrollment-client";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { EnrollmentStatus } from "@/domain/account-enrollment";

const account: VerifiedAccount = { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 2 };
const pending: EnrollmentStatus = { ownerId: account.userId, generation: 1, status: "pending", updatedAt: "2026-10-27T00:00:00Z", capabilities: { home_attachments: false, identity_transactions: false, strategy: false, naming: false, logo: false } };
let client: ReturnType<typeof createAccountEnrollmentClient>;
const flush = () => Promise.resolve().then(() => Promise.resolve());
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(() => { client?.dispose(); vi.useRealTimers(); });

it("ensures once, recovers a lost mutation acknowledgment by reads, and never retries the write on focus", async () => {
  const request = vi.fn().mockRejectedValueOnce(new AccountRequestError(408)).mockResolvedValue({ enrollment: pending });
  const publish = vi.fn(), expire = vi.fn();
  client = createAccountEnrollmentClient({ account, request, publish, expire, isCurrent: () => true });
  client.start(); client.start(); await flush();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![2]).toMatchObject({ method: "POST", body: {}, expectedOwnerId: account.userId });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(request.mock.calls[1]![2].method).toBe("GET"); expect(publish).toHaveBeenLastCalledWith(pending);
  window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); await flush();
  expect(request.mock.calls.filter(call => call[2].method === "POST")).toHaveLength(1);
  expect(expire).not.toHaveBeenCalled();
});

it("ignores an old-account response, aborts on disposal, and cannot expire a newer session", async () => {
  let resolve!: (value: { enrollment: EnrollmentStatus }) => void;
  let current = true;
  const request = vi.fn(() => new Promise<{ enrollment: EnrollmentStatus }>(done => { resolve = done; }));
  const publish = vi.fn(), expire = vi.fn();
  client = createAccountEnrollmentClient({ account, request: request as never, publish, expire, isCurrent: () => current });
  client.start(); current = false; client.dispose(); resolve({ enrollment: pending }); await flush();
  expect(request.mock.calls[0]).toBeDefined(); expect(publish).not.toHaveBeenCalled(); expect(expire).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([503, 502])("preserves authenticated work on %s and rejects foreign owner status", async status => {
  const publish = vi.fn(), expire = vi.fn();
  const request = vi.fn().mockRejectedValueOnce(new AccountRequestError(status)).mockResolvedValue({ enrollment: { ...pending, ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
  client = createAccountEnrollmentClient({ account, request, publish, expire, isCurrent: () => true });
  client.start(); await flush(); await vi.advanceTimersByTimeAsync(15_000);
  expect(publish).not.toHaveBeenCalled(); expect(expire).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(2);
});

it("expires only its current verified session after a real401", async () => {
  const expire = vi.fn();
  client = createAccountEnrollmentClient({ account, request: vi.fn().mockRejectedValue(new AccountRequestError(401)), publish: vi.fn(), expire, isCurrent: () => true });
  client.start(); await flush(); expect(expire).toHaveBeenCalledExactlyOnceWith(account); expect(vi.getTimerCount()).toBe(0);
});
