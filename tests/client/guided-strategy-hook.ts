import type { StrategyOverview } from "@/domain/strategy-jobs";
import { idleStrategyAction, strategyJobsReport, type StrategyAction } from "@/components/workspace/strategy-jobs-view";

/** What a test's stand-in for `useStrategyJobs` holds; the rest of what the hook reports is worked out from it. */
type StrategyHookFixture = {
  overview: unknown;
  readError: string | null;
  actionError: string | null;
  /** This tab's own request, as the hook holds it (a refused start, a Stop on its way). */
  action?: StrategyAction;
};

/** Completes a stand-in for `useStrategyJobs` with the reading the real hook reports (`view`), from the real
 * function, so a test never writes down by hand what may be retried or stopped. */
export function withStrategyView<T extends StrategyHookFixture>(fixture: T) {
  const report = strategyJobsReport({
    overview: (fixture.overview ?? null) as StrategyOverview | null,
    readError: fixture.readError,
    action: fixture.action ?? idleStrategyAction,
  });
  return { ...fixture, actionError: fixture.actionError ?? report.actionError, view: report.view };
}
