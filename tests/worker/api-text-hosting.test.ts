import { describe, expect, it, vi } from "vitest";
import { publishAdmittedDispatch, repairApiTextDispatches } from "../../worker/hosting/publication";
import { apiTextDispatchMessage, type ApiTextDispatchDescriptor } from "../../src/domain/api-text-dispatch";

const descriptor: ApiTextDispatchDescriptor = {
  version: 1, jobId: "10000000-0000-4000-8000-000000000001", operation: "strategy.reformulate",
  policyIdentity: "a".repeat(64), deploymentId: "dpl_qualified", dispatchIdentity: "b".repeat(64),
  state: "queued", retryable: true, publicationGeneration: 0, publishedMessageId: null, publishedAt: null,
};
function fixture(overrides: Partial<ApiTextDispatchDescriptor> = {}) {
  let row = { ...descriptor, ...overrides };
  const sent: Array<{ payload: unknown; options: unknown }> = [];
  const calls: string[] = [];
  let receiptFailure = false;
  let redriveEligible = !!overrides.publishedMessageId;
  const database = { query: vi.fn(async (sql: string, args?: unknown[]) => {
    calls.push(sql);
    if (sql.includes("list_pending_api_text_dispatches")) return { rows: [{ descriptor: row }] };
    if (sql.includes("expire_api_text_job")) return { rows: [{ disposition: row.state }] };
    if (sql.includes("prepare_api_text_redrive")) {
      expect(args).toEqual([row.jobId, row.dispatchIdentity, row.publicationGeneration]);
      if (!redriveEligible) return { rows: [{ descriptor: null }] };
      redriveEligible = false;
      row = { ...row, publicationGeneration: row.publicationGeneration + 1, publishedAt: null, publishedMessageId: null };
      return { rows: [{ descriptor: row }] };
    }
    if (sql.includes("mark_api_text_published")) {
      if (receiptFailure) throw new Error("database failed");
      expect(args).toEqual([row.jobId, row.dispatchIdentity, row.publicationGeneration, "msg_confirmed"]);
      row = { ...row, publishedMessageId: "msg_confirmed", publishedAt: "2026-10-08T03:00:00.000Z" };
      return { rows: [{ recorded: true }] };
    }
    return { rows: [{ descriptor: row }] };
  }) };
  const send = vi.fn(async (_topic: string, payload: unknown, options: unknown) => {
    sent.push({ payload, options }); return { messageId: "msg_confirmed" as string | null };
  });
  const options = { database, send, deploymentId: "dpl_qualified", signal: new AbortController().signal };
  return { options, sent, calls, send, database, row: () => row, failReceipt: () => { receiptFailure = true; },
    allowRedrive: () => { redriveEligible = true; }, restoreReceipt: () => { receiptFailure = false; }, setState: (state: ApiTextDispatchDescriptor["state"]) => { row = { ...row, state, retryable: state === "queued" }; } };
}
describe("hosted API text durable publication", () => {
  it("publishes only the authoritative five-field descriptor, then records a generation-fenced receipt", async () => {
    const f = fixture();
    expect(await publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).toEqual({ state: "published", messageId: "msg_confirmed" });
    expect(f.sent).toEqual([{ payload: apiTextDispatchMessage(descriptor), options: { retentionSeconds: 86_400, idempotencyKey: `api-text:${descriptor.dispatchIdentity}:0` } }]);
  });
  it.each(["jobId", "policyIdentity", "deploymentId", "dispatchIdentity"] as const)("rejects forged %s without publishing", async key => {
    const f = fixture();
    const forged = { ...apiTextDispatchMessage(descriptor), [key]: key === "jobId" ? "10000000-0000-4000-8000-000000000002" : key === "deploymentId" ? "dpl_wrong" : "c".repeat(64) };
    await expect(publishAdmittedDispatch(forged, f.options)).rejects.toThrow();
    expect(f.sent).toHaveLength(0);
  });
  it("rejects extra owner/prompt/model fields and a superseded runtime deployment", async () => {
    const f = fixture();
    await expect(publishAdmittedDispatch({ ...apiTextDispatchMessage(descriptor), ownerId: "forged" }, f.options)).rejects.toThrow();
    await expect(publishAdmittedDispatch(apiTextDispatchMessage(descriptor), { ...f.options, deploymentId: "dpl_old" })).rejects.toThrow();
    expect(f.sent).toHaveLength(0);
  });
  it("replays a lost receipt with the same application identity and Queue dedupe generation", async () => {
    const f = fixture(); f.failReceipt();
    await expect(publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).rejects.toThrow();
    await expect(publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).rejects.toThrow();
    expect(f.sent[0]).toEqual(f.sent[1]);
    expect(f.row().publicationGeneration).toBe(0);
  });
  it("successfully repairs a lost receipt once and skips transport on later replay", async () => {
    const f = fixture(); f.failReceipt();
    await expect(publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).rejects.toThrow();
    f.restoreReceipt();
    expect(await publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).toEqual({ state: "published", messageId: "msg_confirmed" });
    expect(await publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).toEqual({ state: "published", messageId: "msg_confirmed" });
    expect(f.sent).toHaveLength(2); expect(f.sent[0]).toEqual(f.sent[1]);
  });
  it("recognizes consumer progress even when its publisher lost the Queue receipt", async () => {
    const f = fixture(); f.failReceipt();
    f.send.mockImplementationOnce(async () => { f.setState("running"); return { messageId: "msg_confirmed" }; });
    await expect(publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).rejects.toThrow();
    expect(await publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).toEqual({ state: "already_processing" });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("leaves nullable deferred Queue acknowledgements pending without writing a receipt", async () => {
    const f = fixture(); f.send.mockResolvedValue({ messageId: null });
    expect(await publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).toEqual({ state: "dispatch_pending" });
    expect(f.calls.some(sql => sql.includes("mark_api_text_published"))).toBe(false);
  });
  it("retains the same generation after a nullable receipt until transport dedupe expires", async () => {
    const f = fixture(); let now = 0; let expires = -1; let deliveries = 0; const keys: string[] = [];
    f.send.mockImplementation(async (_topic, _payload, options) => {
      const transport = options as { idempotencyKey: string; retentionSeconds: number };
      keys.push(transport.idempotencyKey);
      if (now >= expires) { deliveries += 1; expires = now + transport.retentionSeconds; }
      return { messageId: now < 86_400 ? null : "msg_confirmed" };
    });
    expect(await publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).toEqual({ state: "dispatch_pending" });
    now = 43_200;
    expect(await publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).toEqual({ state: "dispatch_pending" });
    expect(deliveries).toBe(1);
    now = 86_401;
    expect(await publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).toEqual({ state: "published", messageId: "msg_confirmed" });
    expect(deliveries).toBe(2); expect(new Set(keys).size).toBe(1); expect(f.row().publicationGeneration).toBe(0);
  });
  it.each(["running", "succeeded", "failed", "cancelled", "needs_reconciliation"] as const)("uses durable %s state without publishing again", async state => {
    const f = fixture({ state, retryable: false });
    expect(await publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).toEqual({ state: "already_processing" });
    expect(f.sent).toHaveLength(0);
  });
  it("does not claim readiness or a receipt for a blocked queued job", async () => {
    const f = fixture({ retryable: false });
    expect(await publishAdmittedDispatch(apiTextDispatchMessage(descriptor), f.options)).toEqual({ state: "dispatch_pending" });
    expect(f.sent).toHaveLength(0);
  });
  it("repairs a published stalled delivery using a new transport generation and unchanged paid identity", async () => {
    const f = fixture({ publishedMessageId: "old-message", publishedAt: "2026-10-06T03:00:00.000Z" });
    const result = await repairApiTextDispatches(f.options);
    expect(result).toMatchObject({ examined: 1, published: 1, pending: 0, backlogMayRemain: false });
    expect(f.sent[0]).toEqual({ payload: apiTextDispatchMessage(descriptor), options: { retentionSeconds: 86_400, idempotencyKey: `api-text:${descriptor.dispatchIdentity}:1` } });
    expect(f.calls.findIndex(sql => sql.includes("expire_api_text_job"))).toBeLessThan(f.calls.findIndex(sql => sql.includes("prepare_api_text_redrive")));
  });
  it("redrives a SQL-qualified aged missing receipt without waiting for Queue dedupe expiry", async () => {
    const f = fixture(); f.allowRedrive();
    expect(await repairApiTextDispatches(f.options)).toMatchObject({ examined: 1, published: 1 });
    expect(f.sent[0]).toEqual({ payload: apiTextDispatchMessage(descriptor), options: { retentionSeconds: 86_400, idempotencyKey: `api-text:${descriptor.dispatchIdentity}:1` } });
    expect(f.row().dispatchIdentity).toBe(descriptor.dispatchIdentity);
  });
  it("replays an unconfirmed young generation when SQL declines redrive", async () => {
    const f = fixture();
    expect(await repairApiTextDispatches(f.options)).toMatchObject({ examined: 1, published: 1 });
    expect(f.calls.some(sql => sql.includes("prepare_api_text_redrive"))).toBe(true);
    expect(f.row().publicationGeneration).toBe(0);
  });
  it("does not redrive an uncertain paid outcome or an active lease", async () => {
    for (const state of ["needs_reconciliation", "running"] as const) {
      const f = fixture({ state, retryable: false });
      expect(await repairApiTextDispatches(f.options)).toMatchObject({ examined: 1, published: 0 });
      expect(f.sent).toHaveLength(0);
    }
  });
  it("does not mask a bounded full scan as a fully drained outbox", async () => {
    const f = fixture();
    f.database.query.mockImplementation(async (sql: string) => sql.includes("list_pending") ? { rows: Array.from({ length: 25 }, () => ({ descriptor })) } : { rows: [{ descriptor: { ...descriptor, retryable: false } }] });
    expect(await repairApiTextDispatches(f.options)).toMatchObject({ examined: 25, backlogMayRemain: true });
  });
});
