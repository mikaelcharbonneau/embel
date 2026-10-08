import { createHash } from "node:crypto";
import { strategyJobInputSchema, strategyOperationSchema, type StrategyJobPolicy, type StrategyOperation } from "../../src/domain/strategy-jobs";
import { matchesStrategyPolicy, type OpenAIStrategyConfiguration } from "../../src/server/ai/config";
import { createOpenAIResponsesTransport, type OpenAIResponsesTransport } from "../../src/server/ai/openai-transport";
import { executeStrategyResponse } from "../../src/server/ai/strategy-response";
import type { ClaimedJob } from "../../src/domain/jobs";
import type { HandlerRegistry, JobHandler } from "../runner";

export function createOpenAIStrategyHandlers(configuration: OpenAIStrategyConfiguration | null, transport?: OpenAIResponsesTransport,
  assertPolicyReady?: (operation: StrategyOperation, policy: StrategyJobPolicy) => Promise<void>,
  authorizeDispatch?: (job: ClaimedJob, stepKey: string) => Promise<void>): HandlerRegistry {
  if (!configuration) return new Map();
  const provider = transport ?? createOpenAIResponsesTransport({ apiKey: configuration.apiKey });
  const handlers = new Map<string, JobHandler>();
  for (const operation of configuration.policies.keys()) {
    handlers.set(operation, { steps(job) {
      const input = strategyJobInputSchema.parse(job.input);
      const actualOperation = strategyOperationSchema.parse(job.operation);
      if (actualOperation !== operation || !matchesStrategyPolicy(operation, input.policy) ||
          JSON.stringify(configuration.policies.get(operation)) !== JSON.stringify(input.policy) ||
          job.reservedCostMicrousd < input.policy.maximumCostMicrousd) throw new Error("Unsupported strategy policy");
      // A compatible version, price card and request plan must survive worker restart.
      // Successful steps are skipped by the durable runner. Uncertain dispatch is never retried.
      const fingerprint = createHash("sha256").update(JSON.stringify(input.policy)).digest("hex").slice(0, 24);
      const stepKey = `${input.policy.handlerVersion}:${operation}:${fingerprint}`;
      return [{ key: stepKey,
        maximumCostMicrousd: input.policy.maximumCostMicrousd, timeoutMs: 240_000,
        execute: ({ job, signal }) => executeStrategyResponse({ job, operation, input, signal, transport: provider,
          ...((assertPolicyReady || authorizeDispatch) ? { beforeDispatch: async () => {
            await assertPolicyReady?.(operation, input.policy);
            await authorizeDispatch?.(job, stepKey);
          } } : {}) }),
      }];
    } });
  }
  return handlers;
}
