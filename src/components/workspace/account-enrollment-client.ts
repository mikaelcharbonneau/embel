import { accountEnrollmentResponseSchema, type EnrollmentStatus } from "@/domain/account-enrollment";
import type { VerifiedAccount } from "./account-session";
import { AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";

/** Confirmed-account recovery only; provisioning is outside the browser.
 * One idempotent ensure is followed by reads, including after a lost response.
 * Temporary setup failures preserve authenticated work and never trigger AI. */
export function createAccountEnrollmentClient({ account, isCurrent, publish, expire, request = boundedAccountRequest }: {
  account: VerifiedAccount; isCurrent: (account: VerifiedAccount) => boolean;
  publish: (status: EnrollmentStatus | null) => void; expire: (account: VerifiedAccount) => void;
  request?: typeof boundedAccountRequest;
}) {
  let active = true, started = false, reading = false;
  let pending: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => active && isCurrent(account);
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const schedule = (milliseconds: number) => {
    clearTimer();
    if (current()) timer = setTimeout(() => { if (document.visibilityState === "visible") void read("GET"); }, milliseconds);
  };
  async function read(method: "GET" | "POST") {
    if (!current() || reading) return;
    clearTimer(); reading = true;
    const controller = new AbortController(); pending = controller;
    try {
      const { enrollment } = await request("/api/account/enrollment", accountEnrollmentResponseSchema, {
        method, ...(method === "POST" ? { body: {} } : {}), expectedOwnerId: account.userId, signal: controller.signal,
      });
      if (!current() || controller.signal.aborted) return;
      if (enrollment && enrollment.ownerId !== account.userId) throw new AccountRequestError(502);
      publish(enrollment);
      if (enrollment?.status !== "ready") schedule(enrollment?.status === "unavailable" ? 15_000 : 5_000);
    } catch (error) {
      if (!current() || controller.signal.aborted) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else schedule(15_000);
    } finally { reading = false; if (pending === controller) pending = undefined; }
  }
  const refresh = () => { if (document.visibilityState === "visible") void read("GET"); };
  return {
    start() {
      if (started || !current()) return;
      started = true;
      window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
      void read("POST");
    },
    dispose() {
      active = false; clearTimer(); pending?.abort();
      window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh);
    },
  };
}
