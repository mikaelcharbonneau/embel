import { z } from "zod";
import { OperationDeadlineError } from "./timing";

export type DiagnosticPhase = "database_idle" | "enqueue" | "descriptor_read" | "queue_send" | "receipt_write" |
  "repair_scan" | "repair_item" | "expiry" | "redrive" | "claim" | "plan" | "plan_write" |
  "heartbeat" | "step_begin" | "step_write" | "job_finish" | "policy_check" | "dispatch_authorize" |
  "token_count" | "provider_request" | "provider_execution" | "delivery" | "queue_callback";
export type DiagnosticOutcome = "ok" | "error" | "pending" | "inactive" | "retry_requested" |
  "terminal_ack_requested" | "transport_success" | "transport_failure" | "failed" | "needs_reconciliation";
export type DiagnosticErrorClass = "none" | "deadline" | "validation" | "database" | "database_connection" |
  "database_statement_cancelled" | "queue" | "handler" | "provider" | "aborted";
export type DiagnosticSink = (event: Readonly<{ event: "api_text_stage"; phase: DiagnosticPhase;
  outcome: DiagnosticOutcome; durationMs: number; errorClass: DiagnosticErrorClass }>) => void;
const phases = new Set<string>(["database_idle", "enqueue", "descriptor_read", "queue_send", "receipt_write", "repair_scan", "repair_item", "expiry", "redrive", "claim", "plan", "plan_write", "heartbeat", "step_begin", "step_write", "job_finish", "policy_check", "dispatch_authorize", "token_count", "provider_request", "provider_execution", "delivery", "queue_callback"]);
const outcomes = new Set<string>(["ok", "error", "pending", "inactive", "retry_requested", "terminal_ack_requested", "transport_success", "transport_failure", "failed", "needs_reconciliation"]);
const classes = new Set<string>(["none", "deadline", "validation", "database", "database_connection", "database_statement_cancelled", "queue", "handler", "provider", "aborted"]);
const defaultSink: DiagnosticSink = event => console.info(JSON.stringify(event));

/** Allowlist construction only. Never serialize errors, payloads, IDs or context. */
export function diagnose(phase: DiagnosticPhase, outcome: DiagnosticOutcome, started: number,
  errorClass: DiagnosticErrorClass = "none", sink: DiagnosticSink = defaultSink): void {
  try {
    if (!phases.has(phase) || !outcomes.has(outcome) || !classes.has(errorClass)) return;
    const elapsed = Date.now() - started;
    sink(Object.freeze({ event: "api_text_stage", phase, outcome,
      durationMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(3_600_000, Math.round(elapsed))) : 0, errorClass }));
  } catch { /* A broken diagnostic sink cannot affect business execution. */ }
}
export function diagnosticErrorClass(error: unknown, fallback: DiagnosticErrorClass): DiagnosticErrorClass {
  try {
    if (error instanceof OperationDeadlineError) return "deadline";
    if (error instanceof z.ZodError) return "validation";
    // Inspect only an own data property, never a getter, message, cause or client.
    const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
    if (fallback === "database") {
      if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "53300", "57P03", "08000", "08003", "08006"].includes(code)) return "database_connection";
      if (code === "57014") return "database_statement_cancelled";
    }
    return fallback;
  } catch { return fallback; }
}
export async function observeStage<T>(phase: DiagnosticPhase, failure: DiagnosticErrorClass, work: () => Promise<T>,
  sink?: DiagnosticSink, outcome: (result: T) => DiagnosticOutcome = () => "ok"): Promise<T> {
  const started = Date.now();
  try { const result = await work(); try { diagnose(phase, outcome(result), started, "none", sink); } catch { /* Ignore diagnostic-only mapping failures. */ } return result; }
  catch (error) { diagnose(phase, "error", started, diagnosticErrorClass(error, failure), sink); throw error; }
}
