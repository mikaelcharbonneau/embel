import { apiTextDispatchMessageSchema, type ApiTextDispatchMessage } from "../src/domain/api-text-dispatch";
import type { JobDatabase } from "./postgres-store";

export function multiAccountApiTextEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLUID_API_TEXT_MULTI_ACCOUNT_ENABLED === "true";
}

/** Every call carries the same immutable admitted descriptor. There is no owner
 * selector, generic SQL passthrough, deployment fallback, or automatic retry. */
export function apiTextDispatchDatabase(database: JobDatabase, value: ApiTextDispatchMessage): JobDatabase {
  const message = apiTextDispatchMessageSchema.parse(value);
  return { async query(sql, values = []) {
    const query = sql.replace(/\s+/g, " ").trim();
    let action: string; let args: unknown[]; let resultColumn: string | undefined; let rows = false;
    const job = () => { if (values[0] !== message.jobId) throw new Error("Dispatch job mismatch"); };
    const count = (expected: number) => { if (values.length !== expected) throw new Error("Dispatch argument mismatch"); };
    const binding = (policy: unknown, deployment: unknown) => {
      if (policy !== message.policyIdentity || deployment !== message.deploymentId) throw new Error("Dispatch identity mismatch");
    };
    const json = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;
    const descriptor = /^select public\.get_api_text_dispatch\(\$1\) as (dispatch|descriptor)$/.exec(query);
    const expire = /^select public\.expire_api_text_job\(\$1\) as (result|disposition)$/.exec(query);
    if (descriptor) { count(1); job(); action = "descriptor"; args = []; resultColumn = descriptor[1]; }
    else if (expire) { count(1); job(); action = "expire"; args = []; resultColumn = expire[1]; }
    else if (query === "select public.claim_api_text_job($1, $2, $3, $4, $5) as result") {
      count(5); job(); binding(values[3], values[4]); action = "claim"; args = values.slice(1, 3); resultColumn = "result";
    } else if (query === "select public.authorize_api_text_dispatch($1, $2, $3, $4, $5) as authorized") {
      count(5); job(); binding(values[3], values[4]); action = "authorize"; args = values.slice(1, 3); resultColumn = "authorized";
    } else if (query === "select public.check_api_text_runtime($1, $2, $3) as ready") {
      count(3); if (values[2] !== message.deploymentId) throw new Error("Dispatch identity mismatch");
      action = "runtime"; args = [values[0], json(values[1])]; resultColumn = "ready";
    } else if (query === "select public.mark_api_text_published($1,$2,$3,$4) as recorded") {
      count(4); job(); if (values[1] !== message.dispatchIdentity) throw new Error("Dispatch identity mismatch");
      action = "published"; args = values.slice(2); resultColumn = "recorded";
    } else if (query === "select public.prepare_api_text_redrive($1,$2,$3) as descriptor") {
      count(3); job(); if (values[1] !== message.dispatchIdentity) throw new Error("Dispatch identity mismatch");
      action = "redrive"; args = values.slice(2); resultColumn = "descriptor";
    } else if (query === "select * from public.heartbeat_job($1, $2, $3)") {
      count(3); job(); action = "heartbeat"; args = values.slice(1);
    } else if (query === "select * from public.register_job_plan($1, $2, $3)") {
      count(3); job(); action = "plan"; args = [values[1], json(values[2])];
    } else if (query === "select * from public.begin_job_step($1, $2, $3, $4, $5)") {
      count(5); job(); action = "begin"; args = values.slice(1);
    } else if (query === "select * from public.complete_job_step($1, $2, $3, $4, $5, $6, $7)") {
      count(7); job(); action = "complete"; args = [values[1], values[2], values[3], values[4], json(values[5]), values[6]];
    } else if (query === "select * from public.finish_job($1, $2, $3, $4)") {
      count(4); job(); action = "finish"; args = values.slice(1);
    } else if (query === "select state, request_key, reserved_cost_microusd from public.job_steps where job_id = $1 and owner_id = $2 and project_id = $3 and step_key = $4") {
      count(4); job(); action = "step"; args = values.slice(1); rows = true;
    } else if (query === "select exists(select 1 from public.job_steps where job_id=$1 and owner_id=$2 and project_id=$3 and state='succeeded') as has_results") {
      count(3); job(); action = "has_results"; args = values.slice(1); resultColumn = "has_results";
    } else { throw new Error("Unsupported descriptor-bound query"); }
    const result = await database.query("select public.api_text_dispatch_action($1::jsonb,$2,$3::jsonb) as result",
      [JSON.stringify(message), action, JSON.stringify(args)]);
    if (result.rows.length !== 1 || !("result" in result.rows[0]!)) throw new Error("Dispatch response unavailable");
    const payload = result.rows[0]!.result;
    if (resultColumn) return { rows: [{ [resultColumn]: payload }] };
    if (rows) {
      if (!Array.isArray(payload) || payload.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Dispatch response unavailable");
      return { rows: payload };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Dispatch response unavailable");
    return { rows: [payload as Record<string, unknown>] };
  } };
}
