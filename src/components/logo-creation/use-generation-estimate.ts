"use client";

import type { LogoQuoteRequest } from "@/domain/logo-jobs";

/** Logo work runs on the generation engine: one deliberate click starts the run.
 * `errorKey` names the request whose start failed, so only its action explains why. */
export type LogoEngineStarter = {
  busy: boolean;
  error: string | null;
  errorKey: string | null;
  start(request: LogoQuoteRequest): void;
  clearError(): void;
};

/** One Logo action bound to the exact saved inputs it would draw from. Without the
 * engine (its Logo kinds turned off, or not read yet) nothing can start. */
export function useGenerationEstimate(request: LogoQuoteRequest | null, engine: LogoEngineStarter | null) {
  const key = request ? JSON.stringify(request) : null;
  const ready = Boolean(engine && key && !engine.busy);
  return {
    canStart: ready,
    error: engine && engine.errorKey === key ? engine.error : null,
    busy: Boolean(engine?.busy),
    enabled: Boolean(engine && key),
    refresh() {
      engine?.clearError();
    },
    start() {
      if (ready && key) engine!.start(JSON.parse(key) as LogoQuoteRequest);
    },
  };
}
export type GenerationEstimate = ReturnType<typeof useGenerationEstimate>;
