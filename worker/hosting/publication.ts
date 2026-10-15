import { apiTextDispatchDescriptorSchema, apiTextDispatchMessage, apiTextDispatchMessageSchema, type ApiTextDispatchDescriptor } from "../../src/domain/api-text-dispatch";
import { bounded } from "./timing";
import { apiTextDispatchDatabase } from "../api-text-multi-account";

export const API_TEXT_TOPIC = "fluid-api-text-v1";
export const QUEUE_RETENTION_SECONDS = 86_400;
export type PublicationResult = { state: "published" | "dispatch_pending" | "already_processing"; messageId?: string };
export type HostingDatabase = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
export type PublicationDependencies = {
  database: HostingDatabase;
  send(topic: string, message: unknown, options: { retentionSeconds: number; idempotencyKey: string }): Promise<{ messageId: string | null }>;
  deploymentId: string;
  signal: AbortSignal;
  multiAccount?: boolean;
};
async function query(options: PublicationDependencies, sql: string, values: unknown[] = []) {
  options.signal.throwIfAborted();
  return bounded(options.database.query(sql, values), options.signal, 3_000);
}
async function readDescriptor(jobId: string, options: PublicationDependencies) {
  const result = await query(options, "select public.get_api_text_dispatch($1) as descriptor", [jobId]);
  return apiTextDispatchDescriptorSchema.parse(result.rows[0]?.descriptor);
}
async function publishDescriptor(descriptor: ApiTextDispatchDescriptor, options: PublicationDependencies): Promise<PublicationResult> {
  if (descriptor.deploymentId !== options.deploymentId) throw new Error("Unqualified deployment");
  if (descriptor.state !== "queued") return { state: "already_processing" };
  if (!descriptor.retryable) return { state: "dispatch_pending" };
  if (descriptor.publishedMessageId) return { state: "published", messageId: descriptor.publishedMessageId };
  options.signal.throwIfAborted();
  const receipt = await bounded(options.send(API_TEXT_TOPIC, apiTextDispatchMessage(descriptor), {
    retentionSeconds: QUEUE_RETENTION_SECONDS,
    idempotencyKey: `api-text:${descriptor.dispatchIdentity}:${descriptor.publicationGeneration}`,
  }), options.signal, 8_000);
  // The SDK may accept deferred storage without an ID. Keep the outbox pending.
  if (receipt.messageId === null) return { state: "dispatch_pending" };
  if (typeof receipt.messageId !== "string" || !receipt.messageId.length || receipt.messageId.length > 300) throw new Error("Invalid Queue receipt");
  const recorded = await query(options, "select public.mark_api_text_published($1,$2,$3,$4) as recorded", [
    descriptor.jobId, descriptor.dispatchIdentity, descriptor.publicationGeneration, receipt.messageId,
  ]);
  // A concurrent repair generation can fence an old receipt. It is never success.
  if (recorded.rows[0]?.recorded !== true) return { state: "dispatch_pending" };
  return { state: "published", messageId: receipt.messageId };
}

/** Called only after independent signed workload authentication. No owner comes from HTTP. */
export async function publishAdmittedDispatch(message: unknown, options: PublicationDependencies): Promise<PublicationResult> {
  const requested = apiTextDispatchMessageSchema.parse(message);
  if (options.multiAccount) options = { ...options, database: apiTextDispatchDatabase(options.database, requested), multiAccount: false };
  const descriptor = await readDescriptor(requested.jobId, options);
  const canonical = apiTextDispatchMessage(descriptor);
  if (Object.keys(canonical).some(key => canonical[key as keyof typeof canonical] !== requested[key as keyof typeof requested])) throw new Error("Dispatch descriptor mismatch");
  return publishDescriptor(descriptor, options);
}

/** One bounded batch; SQL fences redrive and preserves job/step/reservation identity. */
export async function repairApiTextDispatches(options: PublicationDependencies) {
  const batch = await query(options, options.multiAccount
    ? "select public.list_api_text_dispatches_v2($1) as descriptor"
    : "select public.list_pending_api_text_dispatches($1) as descriptor", [25]);
  if (batch.rows.length > 25) throw new Error("Repair batch overflow");
  const summary = { examined: 0, published: 0, pending: 0, inactive: 0, errors: 0, backlogMayRemain: batch.rows.length === 25 };
  for (const item of batch.rows) {
    if (options.signal.aborted) { summary.backlogMayRemain = true; break; }
    summary.examined += 1;
    try {
      const previous = apiTextDispatchDescriptorSchema.parse(item.descriptor);
      const current = options.multiAccount ? { ...options, database: apiTextDispatchDatabase(options.database, apiTextDispatchMessage(previous)), multiAccount: false } : options;
      await query(current, "select public.expire_api_text_job($1) as disposition", [previous.jobId]);
      let descriptor = await readDescriptor(previous.jobId, current);
      if (descriptor.deploymentId !== options.deploymentId || !descriptor.retryable || descriptor.state !== "queued") {
        summary.inactive += 1; continue;
      }
      // SQL uses durable generation age, not receipt presence, so an accepted-but-
      // unconfirmed exhausted message can recover before the Queue dedupe TTL.
      const redrive = await query(current, "select public.prepare_api_text_redrive($1,$2,$3) as descriptor", [descriptor.jobId, descriptor.dispatchIdentity, descriptor.publicationGeneration]);
      if (redrive.rows[0]?.descriptor != null) descriptor = apiTextDispatchDescriptorSchema.parse(redrive.rows[0].descriptor);
      else if (descriptor.publishedMessageId) { summary.pending += 1; continue; }
      const result = await publishDescriptor(descriptor, current);
      if (result.state === "published") summary.published += 1;
      else summary.pending += 1;
    } catch {
      // Do not leak prompts/DB errors or abort the rest of a healthy bounded batch.
      summary.errors += 1;
      summary.backlogMayRemain = true;
    }
  }
  return summary;
}
