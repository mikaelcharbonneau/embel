import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { namingResponsesJobInputSchema, namingResponsesRunSchema, namingResponsesDispatchSchema, type NamingResponsesRequest } from "../src/domain/naming-responses";
import { validateNamingResponsesRequest } from "../src/server/ai/naming-responses/prompts";
import type { ClaimedJob } from "../src/domain/jobs";
import type { JobDatabase } from "./postgres-store";

/** Separate from NamingBrainJobStore: never reinterpret an Agents call/receipt
 * or let the generic runner settle a Responses reservation from actual=0. */
export class NamingResponsesJobStore {
  private readonly input;
  constructor(private readonly db: JobDatabase, private readonly job: ClaimedJob) {
    this.input = namingResponsesJobInputSchema.parse(job.input);
    if (job.operation !== "naming.generate") throw Error("responses_job_scope_mismatch");
  }
  private async action(action: string, payload: unknown) {
    const result = await this.db.query("select public.naming_responses_worker_action($1::uuid,$2::uuid,$3::text,$4::jsonb) result", [this.job.id, this.job.leaseToken, action, JSON.stringify(payload)]);
    if (result.rows.length !== 1) throw Error("responses_store_reply_missing");
    return result.rows[0]!.result;
  }
  async load() {
    const run = namingResponsesRunSchema.parse(await this.action("load", {}));
    if (run.runId !== this.input.runId || run.dispatches.some(row => row.request.runId !== this.input.runId)) throw Error("responses_run_scope_mismatch");
    for (const row of run.dispatches) validateNamingResponsesRequest(row.request);
    return run;
  }
  async reserve(raw: NamingResponsesRequest) {
    const request = validateNamingResponsesRequest(raw);
    if (request.runId !== this.input.runId) throw Error("responses_run_scope_mismatch");
    const row = namingResponsesDispatchSchema.parse(await this.action("reserve", request));
    if (!isDeepStrictEqual(row.request, request)) throw Error("responses_frozen_request_mismatch");
    return row;
  }
  async begin(dispatchKey: string) { return z.boolean().parse(await this.action("begin", { dispatchKey })); }
  async handle(dispatchKey: string, responseId: string) {
    const row = namingResponsesDispatchSchema.parse(await this.action("handle", { dispatchKey, responseId }));
    if (row.request.runId !== this.input.runId || row.request.dispatchKey !== dispatchKey || row.responseId !== responseId) throw Error("responses_handle_mismatch");
    return row;
  }
  async observe(dispatchKey: string, response: unknown, requestId: string | null) {
    const row = namingResponsesDispatchSchema.parse(await this.action("observe", { dispatchKey, response: z.json().parse(response), requestId }));
    if (row.request.runId !== this.input.runId || row.request.dispatchKey !== dispatchKey) throw Error("responses_observation_scope_mismatch");
    return row;
  }
  async reject(dispatchKey: string, requestId: string, code: "provider_request_rejected") {
    const row = namingResponsesDispatchSchema.parse(await this.action("reject", { dispatchKey, requestId, code }));
    if (row.request.runId !== this.input.runId || row.request.dispatchKey !== dispatchKey) throw Error("responses_rejection_scope_mismatch");
    return row;
  }
}
