"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { LogoCostQuote, LogoQuoteRequest } from "@/domain/logo-jobs";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { LogoCreationController, LogoCreationState } from "./creation-controller";
import { LogoReferenceLimitError } from "./reference-limit";

const EMPTY: LogoCreationState = Object.freeze({ phase: "idle", quote: null, request: null, error: null });
const empty = () => EMPTY, noSubscription = () => () => undefined;
type Estimate = { controller: LogoCreationController; key: string; cycle: string | null; quote: LogoCostQuote | null; error: string | null; expired: boolean };
/** On the generation engine there is no quote: one deliberate click starts the run.
 * `errorKey` names the request whose start failed, so only its action explains why. */
export type LogoEngineStarter = { busy: boolean; error: string | null; errorKey: string | null; start(request: LogoQuoteRequest): void; clearError(): void };

/** Estimates are read-only and bound to the exact saved inputs. Starting work
 * always requires a fresh deliberate action, including after an expired quote. */
export function useGenerationEstimate(controller: LogoCreationController | null, request: LogoQuoteRequest | null, engine: LogoEngineStarter | null = null) {
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? empty, empty);
  const [result, setResult] = useState<Estimate | null>(null);
  const [refresh, setRefresh] = useState(0);
  const key = request ? JSON.stringify(request) : null;
  const cycle = state.request && state.request.status !== "not_found" ? state.request.requestKey : null;
  const enabled = Boolean(!engine && controller && key && state.phase === "idle");
  useEffect(() => {
    if (!controller || !key || !enabled) return;
    const abort = new AbortController();
    let cancelled = false;
    const timer = setTimeout(async () => {
      const timeout = setTimeout(() => abort.abort(), 30_000);
      try {
        const quote = await controller.estimate(JSON.parse(key) as LogoQuoteRequest, abort.signal);
        // A quote that arrives already expired (for example from clock skew) is
        // not replaced automatically, so a bad clock cannot cause a request loop.
        if (!cancelled) setResult(Date.parse(quote.expiresAt) <= Date.now()
          ? { controller, key, cycle, quote: null, expired: false, error: "This request expired before it was ready. Try again." }
          : { controller, key, cycle, quote, error: null, expired: false });
      } catch (error) {
        if (!cancelled) setResult({ controller, key, cycle, quote: null, expired: false, error: error instanceof AccountRequestError && error.status === 409
          ? "Saved inputs changed. Refresh the saved brand, then try again."
          : error instanceof LogoReferenceLimitError ? error.message : "This request could not be prepared. Try again." });
      } finally { clearTimeout(timeout); }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); abort.abort(); };
  }, [controller, cycle, enabled, key, refresh]);

  const current = enabled && result?.controller === controller && result.key === key && result.cycle === cycle ? result : null;
  const quote = current?.quote ?? null;
  // An expired quote is replaced quietly. Preparing a quote never starts work;
  // only the deliberate click below admits a request.
  const replace = () => { setResult(null); setRefresh(value => value + 1); };
  useEffect(() => {
    if (!quote || !controller || !key) return;
    const timer = setTimeout(() => {
      setResult(previous => previous?.controller === controller && previous.key === key && previous.quote === quote ? null : previous);
      setRefresh(value => value + 1);
    }, Math.min(2_147_483_647, Math.max(0, Date.parse(quote.expiresAt) - Date.now())));
    return () => clearTimeout(timer);
  }, [controller, key, quote]);
  const expired = Boolean(current?.expired);
  if (engine) {
    const ready = Boolean(key && !engine.busy && state.phase === "idle");
    return {
      quote: null, canStart: ready, loading: false, expired: false, error: engine.errorKey === key ? engine.error : null, busy: engine.busy, enabled: Boolean(key),
      refresh: engine.clearError,
      start() { if (ready && key) engine.start(JSON.parse(key) as LogoQuoteRequest); },
    };
  }
  const canStart = Boolean(enabled && quote && !expired);
  return {
    quote, canStart, loading: enabled && !current, expired, error: current?.error ?? null,
    busy: state.phase === "admitting" || state.phase === "active", enabled,
    refresh: replace,
    start() {
      if (!canStart || !quote) return;
      if (Date.parse(quote.expiresAt) <= Date.now()) { replace(); return; }
      void controller?.start(quote);
    },
  };
}
export type GenerationEstimate = ReturnType<typeof useGenerationEstimate>;
