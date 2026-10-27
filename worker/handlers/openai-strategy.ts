import { createHash } from "node:crypto";
import { strategyJobInputSchema, strategyOperationSchema, type StrategyJobPolicy, type StrategyOperation } from "../../src/domain/strategy-jobs";
import { guidedTurnOperation } from "../../src/domain/guided-interview";
import { matchesStrategyPolicy, type OpenAIStrategyConfiguration } from "../../src/server/ai/config";
import { createOpenAIResponsesTransport, type OpenAIResponsesTransport } from "../../src/server/ai/openai-transport";
import { executeStrategyResponse } from "../../src/server/ai/strategy-response";
import type { ClaimedJob } from "../../src/domain/jobs";
import type { HandlerRegistry, JobHandler } from "../runner";

export function createOpenAIStrategyHandlers(configuration: OpenAIStrategyConfiguration | null, transport?: OpenAIResponsesTransport,
  assertPolicyReady?: (operation: StrategyOperation, policy: StrategyJobPolicy) => Promise<void>,
  authorizeDispatch?: (job: ClaimedJob, stepKey: string) => Promise<void>,
  hasUnmeteredExecutionAuthority?: (job: ClaimedJob) => boolean): HandlerRegistry {
  if (!configuration) return new Map();
  const provider = transport ?? createOpenAIResponsesTransport({ apiKey: configuration.apiKey });
  const handlers = new Map<string, JobHandler>();
  for (const operation of configuration.policies.keys()) {
    handlers.set(operation, { steps(job) {
      const input = strategyJobInputSchema.parse(job.input);
      const actualOperation = strategyOperationSchema.parse(job.operation);
      const unmetered = hasUnmeteredExecutionAuthority?.(job) === true;
      if ((input.version === 3) !== unmetered) throw new Error("Unsupported Strategy execution authority");
      if (actualOperation !== operation || !matchesStrategyPolicy(operation, input.policy) ||
          JSON.stringify(configuration.policies.get(operation)) !== JSON.stringify(input.policy) ||
          job.reservedCostMicrousd < input.policy.maximumCostMicrousd) throw new Error("Unsupported strategy policy");
      if (input.version !== 1) {
        const state = input.context.intake.guidedInterview;
        const turn = state?.turns.at(-1);
        if (!turn || turn.inputRevision !== job.inputRevision || turn.stage !== state?.stage || guidedTurnOperation(turn) !== operation ||
          state?.answers.some(answer => answer.turnId === turn.id)) throw new Error("Invalid frozen strategy turn");
        if (input.assistantHistory.entries.some(entry => entry.ownerId !== job.ownerId ||
          entry.projectId !== job.projectId || entry.inputRevision >= job.inputRevision || entry.jobId === job.id)) {
          throw new Error("Invalid frozen strategy history");
        }
      }
      // A compatible version, price card and request plan must survive worker restart.
      // Successful steps are skipped by the durable runner. Uncertain dispatch is never retried.
      const fingerprint = createHash("sha256").update(JSON.stringify(input.version !== 1 ? input : input.policy)).digest("hex").slice(0, 24);
      const stepKey = `${input.policy.handlerVersion}:${operation}:${fingerprint}`;
      return [{ key: stepKey,
        maximumCostMicrousd: input.policy.maximumCostMicrousd, timeoutMs: 240_000,
        execute: ({ job, signal }) => executeStrategyResponse({ job, operation, input, signal, transport: provider,
          unmeteredExecution: unmetered,
          ...((assertPolicyReady || authorizeDispatch) ? { beforeDispatch: async () => {
            await assertPolicyReady?.(operation, input.policy);
            await authorizeDispatch?.(job, stepKey);
          } } : {}) }),
      }];
    } });
  }
  return handlers;
}
