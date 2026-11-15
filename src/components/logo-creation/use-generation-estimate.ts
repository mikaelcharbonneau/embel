"use client";

import type { LogoRunRequest } from "@/domain/logo-jobs";

/** Logo work runs on the generation engine: one deliberate click starts the run.
 * `errorKey` names the request whose start failed, so only its action explains why. */
export type LogoEngineStarter = {
  busy: boolean;
  /** A start couldn't be confirmed and is kept: nothing else starts until its Try again is answered. */
  held?: boolean;
  error: string | null;
  errorKey: string | null;
  /** Whether the refusal offers Try again; false when pressing would only be refused again. */
  tryAgain?: boolean;
  start(request: LogoRunRequest): void;
  /** Try again under the refusal: repeats an unconfirmed request, otherwise takes the message away. */
  clearError(): void;
};

/** One Logo action bound to the exact saved inputs it would draw from. Without the
 * engine (its Logo kinds turned off, or not read yet) nothing can start. */
export function useGenerationEstimate(request: LogoRunRequest | null, engine: LogoEngineStarter | null) {
  const key = request ? JSON.stringify(request) : null;
  const ready = Boolean(engine && key && !engine.busy && !engine.held);
  return {
    canStart: ready,
    held: Boolean(engine?.held),
    tryAgain: engine?.tryAgain !== false,
    error: engine && engine.errorKey === key ? engine.error : null,
    busy: Boolean(engine?.busy),
    enabled: Boolean(engine && key),
    refresh() {
      engine?.clearError();
    },
    start() {
      if (ready && key) engine!.start(JSON.parse(key) as LogoRunRequest);
    },
  };
}
export type GenerationEstimate = ReturnType<typeof useGenerationEstimate>;
