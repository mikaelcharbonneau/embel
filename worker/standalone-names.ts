import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type { ChatGPTNamingPolicy } from "../src/domain/naming-jobs";
import { standaloneNamesWorkerInputSchema } from "../src/domain/standalone-names";
import type { ChatGPTTransport } from "../src/server/ai/chatgpt-transport";
import { runStandaloneNames, type StandaloneNamesOutcome } from "../src/server/ai/standalone-names";

type Database = Pick<Pool, "query">;
/** Reconcile abandoned work even when no connected model is ready to claim. */
export async function expireStandaloneNamesLeases(database: Database): Promise<void> {
  try { await database.query("select public.claim_standalone_names(null::jsonb)"); }
  catch { /* Optional standalone setup must not block the existing project runner. */ }
}

/** Missing candidate schema/grants must never disable the project runner. */
export async function reportStandaloneNamesReady(database: Database, policy: ChatGPTNamingPolicy): Promise<boolean> {
  try {
    const result = await database.query("select public.report_standalone_names_ready($1::jsonb) as ready", [JSON.stringify(policy)]);
    return result.rows.length === 1 && result.rows[0]?.ready === true;
  } catch { return false; }
}

/** One durable job per tick. No HTTP handler owns provider execution. */
export async function runOneStandaloneNamesJob(options: {
  database: Database; ownerId: string; policy: ChatGPTNamingPolicy; transport: ChatGPTTransport;
  signal: AbortSignal; assertReady: () => Promise<void>; onQuotaUnavailable?: () => Promise<void>;
}): Promise<boolean> {
  if (options.signal.aborted) return false;
  let raw: unknown;
  try {
    const claim = await options.database.query("select public.claim_standalone_names($1::jsonb) as input", [JSON.stringify(options.policy)]);
    if (claim.rows.length !== 1 || claim.rows[0]?.input == null) return false;
    raw = claim.rows[0].input;
  } catch { return false; }
  const parsed = standaloneNamesWorkerInputSchema.safeParse(raw);
  // Invalid claims are never dispatched. Their single attempt expires to a
  // failed/reconciliation state; a fabricated worker row cannot select an owner.
  if (!parsed.success || parsed.data.job.ownerId !== options.ownerId || !isDeepStrictEqual(parsed.data.policy, options.policy)) return false;
  const input = parsed.data;
  const cancel = new AbortController();
  const deadline = new AbortController();
  const signal = AbortSignal.any([options.signal, cancel.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), input.policy.limits.deadlineMs);
  let partialText = "", persistedText = "", lastFlush = 0, stopped = false;
  let pulses: Promise<void> = Promise.resolve();
  const pulse = (begin = false, partial: string | null = null) => {
    const task = pulses.then(async () => {
      if (stopped) throw new Error("Standalone naming worker stopped");
      const result = await options.database.query("select public.pulse_standalone_names($1,$2,$3,$4) as state", [input.job.id, input.leaseToken, begin, partial]);
      if (result.rows.length !== 1 || result.rows[0]?.state !== "running") { cancel.abort(); throw new Error("Standalone naming cancellation requested"); }
      if (partial !== null) { persistedText = partial; lastFlush = Date.now(); }
    });
    pulses = task.catch(() => { cancel.abort(); });
    return task;
  };
  const heartbeat = setInterval(() => { void pulse().catch(() => {}); }, 2000);
  let grace: ReturnType<typeof setTimeout> | undefined;
  let stopListener = () => {};
  const interrupted = new Promise<StandaloneNamesOutcome>(resolve => {
    stopListener = () => {
      grace = setTimeout(() => resolve({ state: "needs_reconciliation", result: null, partialText, errorCode: "provider_outcome_unknown" }), 5000);
    };
    signal.addEventListener("abort", stopListener, { once: true });
    if (signal.aborted) stopListener();
  });
  try {
    const outcome = await Promise.race([
      runStandaloneNames({ input, transport: options.transport, signal,
        beforeDispatch: async () => { await options.assertReady(); if (signal.aborted) throw new Error("Standalone naming session ended"); await pulse(true); },
        onPartial: async text => {
          if (stopped || signal.aborted) throw new Error("Standalone naming worker stopped");
          partialText = text;
          if (!persistedText || Date.now() - lastFlush >= 1000 || Buffer.byteLength(text.slice(persistedText.length), "utf8") >= 4096) await pulse(false, text);
        },
      }), interrupted,
    ]);
    clearInterval(heartbeat);
    await pulses;
    if (outcome.partialText.startsWith(partialText)) partialText = outcome.partialText;
    let state = outcome.state, result = outcome.result, errorCode = outcome.errorCode;
    if (state === "succeeded") {
      try { await options.assertReady(); if (signal.aborted) throw new Error("Standalone naming session ended"); await pulse(); }
      catch { state = "needs_reconciliation"; result = null; errorCode = "runtime_changed_after_dispatch"; }
    }
    stopped = true;
    const finished = await options.database.query("select public.finish_standalone_names($1,$2,$3,$4::jsonb,$5,$6) as saved",
      [input.job.id, input.leaseToken, state, result === null ? null : JSON.stringify(result), partialText, errorCode]);
    if (finished.rows.length !== 1 || finished.rows[0]?.saved !== true) return false;
    if (errorCode === "quota_unavailable") await options.onQuotaUnavailable?.().catch(() => {});
    return true;
  } catch {
    // A missing acknowledgement/lease never triggers another provider call.
    // The durable lease expiry leaves an explicit reconciliation state.
    return false;
  } finally {
    stopped = true; clearTimeout(timer); clearInterval(heartbeat); if (grace) clearTimeout(grace);
    signal.removeEventListener("abort", stopListener); cancel.abort();
  }
}
