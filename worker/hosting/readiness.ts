import { apiTextDeploymentSchema } from "../../src/domain/api-text-dispatch";
import type { StrategyOperation } from "../../src/domain/strategy-jobs";
import { isHostedStrategyPolicy, type OpenAIStrategyConfiguration } from "../../src/server/ai/config";
import { bounded } from "./timing";

type Readiness = { version: 1; deploymentId: string; operations: StrategyOperation[] };
type ReadinessDatabase = {
  query(sql: string, values: unknown[]): Promise<{ rows: Array<{ operation?: unknown; ready?: unknown }> }>;
};
const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality", "strategy.positioning", "strategy.slogan"] as const;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Checks existing approval using the existing restricted login. No admission or provider call. */
export async function readApiTextWorkerReadiness(options: {
  deploymentId: string; configuration: OpenAIStrategyConfiguration | null;
  database(): ReadinessDatabase; signal: AbortSignal;
  multiAccount?: boolean;
}): Promise<Readiness> {
  const deploymentId = apiTextDeploymentSchema.regex(/^dpl_[A-Za-z0-9_-]{1,196}$/).parse(options.deploymentId);
  const policies = operations.flatMap(operation => {
    const policy = options.configuration?.policies.get(operation);
    return policy && isHostedStrategyPolicy(operation, policy)
      ? [[operation, policy] as const] : [];
  });
  const readiness: Readiness = { version: 1, deploymentId, operations: [] };
  options.signal.throwIfAborted();
  if (!policies.length) return readiness;
  // One bounded statement uses only the already-granted qualification function.
  // That function derives the owner from session_user and checks the exact binding.
  const result = await bounded(options.database().query(
    options.multiAccount ? "select operation, ready from public.api_text_multi_account_readiness($1::jsonb,$2)"
      : "select operation, public.check_api_text_runtime(operation, policy, $2) as ready from jsonb_to_recordset($1::jsonb) as candidate(operation text, policy jsonb)",
    [JSON.stringify(policies.map(([operation, policy]) => ({ operation, policy }))), deploymentId],
  ), options.signal, 5_000);
  options.signal.throwIfAborted();
  const remaining = new Set<StrategyOperation>(policies.map(([operation]) => operation));
  for (const row of result.rows) {
    const operation = row.operation as StrategyOperation;
    if (!remaining.delete(operation) || typeof row.ready !== "boolean") throw new Error("Runtime unavailable");
    if (row.ready) readiness.operations.push(operation);
  }
  if (remaining.size) throw new Error("Runtime unavailable");
  readiness.operations.sort();
  return readiness;
}

/** Authenticates a body-free probe; never calls enqueue, repair, a queue, or inference. */
export async function handleApiTextReadiness(request: Request, dependencies: {
  verify(authorization: string | null): Promise<void>;
  inspect(signal: AbortSignal): Promise<Readiness>;
}): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  try { await bounded(dependencies.verify(request.headers.get("authorization")), signal, 4_000); }
  catch { return json({ error: "unauthorized" }, 401); }
  if (new URL(request.url).search || request.body) return json({ error: "invalid_input" }, 400);
  try { return json(await bounded(dependencies.inspect(signal), signal, 5_000)); }
  catch { return json({ error: "runtime_unavailable" }, 503); }
}
