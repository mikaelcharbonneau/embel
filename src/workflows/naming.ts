import { getWorkflowMetadata, sleep } from "workflow";
import { checkRun, claimRun, finishRun } from "./engine-steps";
import {
  createNamingResponse,
  planNamingRound,
  pollNamingResponses,
  recordNamingFailure,
  settleNamingResponse,
  stopNamingResponses,
  type NamingOpenRequest,
  type NamingRunState,
} from "./naming-steps";

/** A round of names is 100; at most three rounds fill a short first round. */
const TARGET = 100,
  MAX_ROUNDS = 3;
/** Seconds between lookups: quick at first, then every 5 s, for about 4 minutes per round. */
const POLL_DELAYS = [2, 2, 3, 3, 4, 4, ...Array.from({ length: 44 }, () => 5)];
const CODE = /^[a-z_]{1,64}$/u;
const codeOf = (error: unknown, fallback: string) =>
  error instanceof Error && CODE.test(error.message) ? error.message : fallback;

/**
 * Runs one Naming request (kind naming.generate) on OpenAI background mode: the first names,
 * More names or a steered set. Each round sends up to three requests side by side and saves
 * each reply's checked names as soon as it finishes, until 100 names are saved or three
 * rounds have run. Saved names always stay. A run that saved names succeeds, even short of
 * 100; one that saved none fails and returns its credit, as does a cancelled run.
 */
export async function namingGeneration(runId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const run = await claimRun(runId, workflowRunId);
  if (run.status !== "running") return { status: run.status };
  let state: NamingRunState = { savedCount: 0, identities: [], approaches: [] };
  try {
    const codes: string[] = [];
    for (let round = 1; round <= MAX_ROUNDS && state.savedCount < TARGET; round++) {
      // No paid call starts after a cancel or while the engine is paused.
      const check = await checkRun(runId);
      if (check.status !== "running") return { status: check.status };
      if (check.cancelRequested || check.paused)
        return await finishRun(runId, "cancelled", check.paused ? "generation_paused" : "cancelled");
      let open: NamingOpenRequest[] = [];
      for (const plan of await planNamingRound(run, state, round)) {
        try {
          open.push({ plan, responseId: (await createNamingResponse(run, plan, state)).responseId });
        } catch (error) {
          const code = codeOf(error, "provider_unavailable");
          codes.push(code);
          await recordNamingFailure(runId, plan, code);
        }
      }
      // Nothing could be sent; another round would most likely fail the same way.
      if (!open.length) break;
      for (const seconds of POLL_DELAYS) {
        await sleep(`${seconds}s`);
        const polled = await pollNamingResponses(
          runId,
          open.map((item) => item.responseId),
        );
        if (polled.state === "stop") {
          // Stopping always ends the run as cancelled, even if OpenAI can't be reached to cancel.
          const stopped = state;
          await stopNamingResponses(run, open, state, polled.code).catch(() => stopped);
          return await finishRun(runId, "cancelled", polled.code);
        }
        for (const responseId of polled.finished) {
          const item = open.find((entry) => entry.responseId === responseId);
          if (!item) continue;
          const settled = await settleNamingResponse(run, item.plan, state, responseId);
          state = settled.state;
          if (settled.code) codes.push(settled.code);
          open = open.filter((entry) => entry !== item);
        }
        if (!open.length) break;
      }
      if (open.length) {
        const timedOut = state;
        state = await stopNamingResponses(run, open, state, "response_timeout").catch(() => timedOut);
        codes.push("response_timeout");
      }
    }
    if (state.savedCount > 0) return await finishRun(runId, "succeeded", null);
    // Replies that came back without a usable name say more than a transport failure.
    const last = codes.at(-1);
    return await finishRun(runId, "failed", codes.includes("no_names") || !last ? "no_names" : last);
  } catch (error) {
    // Names already saved stay and the run counts as done; a run without names returns its
    // credit. Codes come from FatalError messages.
    if (state.savedCount > 0) await finishRun(runId, "succeeded", null);
    else await finishRun(runId, "failed", codeOf(error, "generation_failed"));
    throw error;
  }
}
