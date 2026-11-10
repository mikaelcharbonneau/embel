import { getWorkflowMetadata } from "workflow";
import { claimRun, finishRun, saveOutput } from "./engine-steps";

/** Zero-cost run that proves start, claim, save and finish work end to end (kind "engine.probe"). */
export async function probeGeneration(runId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const run = await claimRun(runId, workflowRunId);
  if (run.status !== "running") return { status: run.status };
  try {
    await saveOutput(runId, "echo", { message: "The generation engine is working." }, null, 0);
  } catch (error) {
    await finishRun(runId, "failed", "probe_failed");
    throw error;
  }
  return finishRun(runId, "succeeded", null);
}
