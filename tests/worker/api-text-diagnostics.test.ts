import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { diagnose, diagnosticErrorClass, observeStage, type DiagnosticSink } from "../../worker/hosting/diagnostics";
import { publishAdmittedDispatch, repairApiTextDispatches } from "../../worker/hosting/publication";
import { handleEnqueue } from "../../worker/hosting/http";
import { OperationDeadlineError } from "../../worker/hosting/timing";
const descriptor = { version: 1, jobId: "10000000-0000-4000-8000-000000000001", operation: "strategy.reformulate", policyIdentity: "a".repeat(64), deploymentId: "dpl_synthetic", dispatchIdentity: "b".repeat(64), state: "queued", retryable: true, publicationGeneration: 0, publishedMessageId: null, publishedAt: null };
const message = { version: 1 as const, jobId: descriptor.jobId, policyIdentity: descriptor.policyIdentity, deploymentId: descriptor.deploymentId, dispatchIdentity: descriptor.dispatchIdentity };
const secret = "SYNTHETIC_SECRET_DO_NOT_LOG";
function fixture(fail?: string, throwingSink = false) {
  const events: Parameters<DiagnosticSink>[0][] = [];
  const error = Object.assign(new Error(secret, { cause: { password: secret, authorization: secret } }), {
    headers: { authorization: secret }, client: { connectionParameters: { password: secret } }, prompt: secret, ownerId: secret,
  });
  const diagnostics: DiagnosticSink = event => { events.push(event); if (throwingSink) throw error; };
  const database = { query: vi.fn(async (sql: string) => {
    if (fail && sql.includes(fail)) throw error;
    if (sql.includes("mark_api_text_published")) return { rows: [{ recorded: true }] };
    return { rows: [{ descriptor }] };
  }) };
  const send = vi.fn(async () => { if (fail === "send") throw error; return { messageId: "msg_synthetic" as string | null }; });
  return { error, events, options: { database, send, diagnostics, deploymentId: descriptor.deploymentId, signal: new AbortController().signal } };
}
afterEach(() => vi.restoreAllMocks());
describe("allowlisted API text diagnostics", () => {
  it.each([["get_api_text_dispatch", "descriptor_read", "database"], ["send", "queue_send", "queue"], ["mark_api_text_published", "receipt_write", "database"]])("distinguishes %s without exposing raw failure context", async (fail, phase, errorClass) => {
    const f = fixture(fail);
    await expect(publishAdmittedDispatch(message, f.options)).rejects.toBe(f.error);
    expect(f.events.at(-1)).toMatchObject({ event: "api_text_stage", phase, outcome: "error", errorClass });
    expect(JSON.stringify(f.events)).not.toContain(secret);
    for (const event of f.events) expect(Object.keys(event).sort()).toEqual(["durationMs", "errorClass", "event", "outcome", "phase"]);
  });
  it("keeps pending receipts distinguishable from confirmed durable publication", async () => {
    const f = fixture(); f.options.send.mockResolvedValue({ messageId: null });
    expect(await publishAdmittedDispatch(message, f.options)).toEqual({ state: "dispatch_pending" });
    expect(f.events.at(-1)).toMatchObject({ phase: "queue_send", outcome: "pending" });
    expect(f.options.database.query).toHaveBeenCalledTimes(1);
  });
  it("contains logging failure without changing successful or failed publication", async () => {
    const success = fixture(undefined, true);
    expect(await publishAdmittedDispatch(message, success.options)).toEqual({ state: "published", messageId: "msg_synthetic" });
    const failure = fixture("send", true);
    await expect(publishAdmittedDispatch(message, failure.options)).rejects.toBe(failure.error);
  });
  it("contains logging failure without changing authorization or pending HTTP responses", async () => {
    const diagnostics = () => { throw new Error(secret); };
    const request = () => new Request("https://worker.invalid/api/enqueue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
    const publish = vi.fn(async (): Promise<never> => { throw new Error(secret); });
    expect((await handleEnqueue(request(), { diagnostics, verify: async () => { throw new Error(secret); }, publish })).status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
    expect((await handleEnqueue(request(), { diagnostics, verify: async () => {}, publish })).status).toBe(503);
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("retains batch error/backlog semantics when the sink fails", async () => {
    const f = fixture("expire_api_text_job", true);
    expect(await repairApiTextDispatches(f.options)).toMatchObject({ errors: 1, backlogMayRemain: true });
    expect(f.options.send).not.toHaveBeenCalled();
  });
  it("never reads message/cause/header/client getters or stringifies arbitrary code", () => {
    const getter = vi.fn(() => { throw new Error(secret); });
    const error = Object.defineProperties({}, Object.fromEntries(["message", "cause", "headers", "client", "code"].map(name => [name, { get: getter }])));
    expect(diagnosticErrorClass(error, "database")).toBe("database"); expect(getter).not.toHaveBeenCalled();
    expect(diagnosticErrorClass({ code: "57014", message: secret }, "database")).toBe("database_statement_cancelled");
    expect(diagnosticErrorClass({ code: "ECONNREFUSED", password: secret }, "database")).toBe("database_connection");
    expect(diagnosticErrorClass(new OperationDeadlineError(secret), "database")).toBe("deadline");
  });
  it("defends its runtime allowlists and preserves original work errors", async () => {
    const sink = vi.fn();
    diagnose(secret as never, "ok", Date.now(), "none", sink);
    diagnose("claim", secret as never, Date.now(), "none", sink);
    diagnose("claim", "ok", Date.now(), secret as never, sink);
    expect(sink).not.toHaveBeenCalled();
    diagnose("claim", "ok", Number.NaN, "none", sink); expect(sink.mock.calls[0]?.[0].durationMs).toBe(0);
    const error = new Error(secret);
    await expect(observeStage("claim", "database", async () => { throw error; }, () => { throw error; })).rejects.toBe(error);
  });
});
