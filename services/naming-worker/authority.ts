import type { NamingWorkerStatus } from "../../worker/naming-brain-store";
import { namingErrorDelay, waitForNamingPoll } from "./scheduling";
import { NamingContinuationUnavailableError } from "../../src/server/ai/naming-brain/continuation";

const RENEW_MS = 20_000, SAFETY_MS = 1_000;
export type NamingWorkerAuthority = {
  current(): { generation: number } | null;
  assertReady(): Promise<void>;
  stop(): Promise<void>;
};

/** Hosted maintenance ownership is distinct from paid readiness. This local
 * snapshot can only suppress operations; SQL fences every mutation/dispatch.
 * Historical request/receipt and GET observation paths do not use this gate. */
export async function startNamingWorkerAuthority(options: {
  signal: AbortSignal;
  report(generation: number | null): Promise<NamingWorkerStatus>;
  now?: () => number;
  random?: () => number;
  onError?(): void;
}): Promise<NamingWorkerAuthority> {
  const now = options.now ?? (() => performance.now()), sleep = new AbortController();
  let stopped = false, generation: number | null = null, validUntil = 0, paidReady = false;
  let nextAt = now(), failures = 0, reporting: Promise<boolean> | undefined;
  const current = () => !stopped && generation !== null && now() < validUntil ? { generation } : null;
  const fence = () => { stopped = true; validUntil = 0; paidReady = false; sleep.abort(); };
  options.signal.addEventListener("abort", fence, { once: true });
  if (options.signal.aborted) fence();

  const refresh = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    if (reporting) return reporting;
    const requestStart = now(), requestedGeneration = generation;
    reporting = Promise.resolve().then(() => stopped ? undefined : options.report(requestedGeneration)).then(status => {
      if (stopped || !status) return false;
      if (!status.leader) {
        failures = 0;
        generation = null; validUntil = 0; paidReady = false;
        nextAt = now() + (status.reason === "expired" || status.reason === "fenced" ? 1_000 : RENEW_MS);
        return false;
      }
      if (status.generation === null || status.expiresAt === null
        || requestedGeneration !== null && requestedGeneration !== status.generation) throw new Error("naming_worker_generation_mismatch");
      const remaining = Date.parse(status.expiresAt) - Date.parse(status.serverTime);
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 60_000) throw new Error("naming_worker_lease_invalid");
      failures = 0;
      generation = status.generation;
      // Anchor at request START, deduct a margin, and never use local wall time.
      // This also handles lost-ack acquisition replay of a nearly expired lease.
      validUntil = requestStart + remaining - SAFETY_MS;
      paidReady = status.ready && current() !== null;
      nextAt = now() + Math.max(1_000, Math.min(RENEW_MS, validUntil - now() - SAFETY_MS));
      return paidReady;
    }).catch(() => {
      validUntil = 0; paidReady = false;
      if (!stopped) {
        nextAt = now() + namingErrorDelay(failures++, options.random);
        try { options.onError?.(); } catch { /* Diagnostics never confer authority. */ }
      }
      return false;
    }).finally(() => { reporting = undefined; });
    return reporting;
  };
  await refresh();
  const background = (async () => {
    while (!stopped) {
      await waitForNamingPoll(Math.max(0, nextAt - now()), sleep.signal);
      if (!stopped && now() >= nextAt) await refresh();
    }
  })();
  return {
    current,
    async assertReady() {
      if (stopped) throw new Error("naming_readiness_stopped");
      if (!current() || !paidReady && now() < nextAt) throw new NamingContinuationUnavailableError("naming_readiness_unavailable");
      const ready = await refresh();
      if (stopped) throw new Error("naming_readiness_stopped");
      if (!ready || !current()) throw new NamingContinuationUnavailableError("naming_readiness_unavailable");
    },
    async stop() {
      fence();
      await reporting;
      await background;
      options.signal.removeEventListener("abort", fence);
    },
  };
}
