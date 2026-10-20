import type { ClaimedJob } from "../../src/domain/jobs";
import type { OpenAIResponsesTransport } from "../../src/server/ai/openai-transport";
import type { HandlerRegistry, JobStore } from "../runner";
import { diagnose, diagnosticErrorClass, observeStage, type DiagnosticSink } from "./diagnostics";

/** Transparent adapters: only fixed phase/outcome labels reach the diagnostic sink. */
export function observeDeliveryStore(store: JobStore, sink?: DiagnosticSink): JobStore {
  return {
    claim: (...args) => observeStage("claim", "database", () => store.claim(...args), sink),
    registerPlan: (...args) => observeStage("plan_write", "database", () => store.registerPlan(...args), sink),
    heartbeat: (...args) => observeStage("heartbeat", "database", () => store.heartbeat(...args), sink),
    beginStep: (...args) => observeStage("step_begin", "database", () => store.beginStep(...args), sink),
    completeStep: (...args) => observeStage("step_write", "database", () => store.completeStep(...args), sink),
    finish: (...args) => observeStage("job_finish", "database", () => store.finish(...args), sink),
    ...(store.hasUnmeteredExecutionAuthority ? { hasUnmeteredExecutionAuthority: (...args: Parameters<NonNullable<JobStore["hasUnmeteredExecutionAuthority"]>>) => store.hasUnmeteredExecutionAuthority!(...args) } : {}),
  };
}
export function observeDeliveryHandlers(handlers: HandlerRegistry, sink?: DiagnosticSink): HandlerRegistry {
  return new Map([...handlers].map(([operation, handler]) => [operation, { steps(job: ClaimedJob) {
    const started = Date.now();
    try {
      const steps = handler.steps(job);
      diagnose("plan", "ok", started, "none", sink);
      return steps.map(step => ({ ...step, execute: (...args: Parameters<typeof step.execute>) =>
        observeStage("provider_execution", "provider", () => step.execute(...args), sink,
          result => result.status === "succeeded" ? "ok" : result.status) }));
    } catch (error) {
      diagnose("plan", "error", started, diagnosticErrorClass(error, "handler"), sink); throw error;
    }
  } }]));
}
export function observeProviderTransport(transport: OpenAIResponsesTransport, sink?: DiagnosticSink): OpenAIResponsesTransport {
  return {
    countInputTokens: (...args) => observeStage("token_count", "provider", () => transport.countInputTokens(...args), sink),
    createResponse: (...args) => observeStage("provider_request", "provider", () => transport.createResponse(...args), sink),
  };
}
