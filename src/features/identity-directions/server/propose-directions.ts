import "server-only";
import type { ClaimedJob, StepOutcome } from "@/domain/jobs";
import type { LogoProviderObservation, LogoResolvedDirectionInput } from "@/domain/logo-jobs";
export type DirectionDispatchContext = { job: ClaimedJob; beforeDispatch(job: ClaimedJob): Promise<void> };
/** Separately configured quoted text operation. No default model or paid fallback. */
export interface DirectionProvider {
  propose(input: LogoResolvedDirectionInput, signal: AbortSignal, dispatch: DirectionDispatchContext): Promise<{ outcome: StepOutcome; observation: LogoProviderObservation }>;
}
export const LOGO_DIRECTIONS_HANDLER_VERSION = "logo-directions-v1";
