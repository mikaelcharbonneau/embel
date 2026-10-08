import { createHash } from "node:crypto";
import { chatGPTNamingJobInputSchema, chatGPTNamingPolicySchema, type ChatGPTNamingPolicy } from "../../src/domain/naming-jobs";
import { CHATGPT_STREAM_LIMITS, type ChatGPTTransport } from "../../src/server/ai/chatgpt-transport";
import { runChatGPTNaming } from "../../src/server/ai/chatgpt-naming";
import type { HandlerRegistry } from "../runner";

export function createNamingSubscriptionHandlers(options: {
  ownerId: string; policy: ChatGPTNamingPolicy; transport: ChatGPTTransport;
  assertReady: (operation: "naming.generate", policy: ChatGPTNamingPolicy) => Promise<void>;
  appendPartial: (jobId: string, leaseToken: string, cumulativeText: string) => Promise<void>;
  onQuotaUnavailable?: () => Promise<void>; sessionSignal: AbortSignal;
}): HandlerRegistry {
  const selected = chatGPTNamingPolicySchema.parse(options.policy);
  return new Map([["naming.generate", { steps(job) {
    const input = chatGPTNamingJobInputSchema.parse(job.input);
    const { batch, policy } = input;
    if (job.operation !== "naming.generate" || job.ownerId !== options.ownerId || batch.ownerId !== job.ownerId || batch.projectId !== job.projectId ||
        batch.jobId !== job.id || batch.contextRevision !== job.inputRevision || JSON.stringify(policy) !== JSON.stringify(selected) ||
        policy.limits.maxInputBytes > CHATGPT_STREAM_LIMITS.maxInputBytes || policy.limits.maxOutputBytes > CHATGPT_STREAM_LIMITS.maxOutputBytes ||
        policy.limits.deadlineMs > CHATGPT_STREAM_LIMITS.deadlineMs || job.reservedCostMicrousd !== 0 || job.actualCostMicrousd !== 0) throw new Error("Naming subscription binding mismatch");
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
    return [{ key: `naming-chatgpt-v1:naming.generate:${fingerprint}`, maximumCostMicrousd: 0, timeoutMs: policy.limits.deadlineMs,
      async execute({ job, signal }) {
        const combinedSignal = AbortSignal.any([signal, options.sessionSignal]);
        if (combinedSignal.aborted) return { status: "failed", code: "session_unavailable", costMicrousd: 0, providerRequestId: null };
        const assertReady = async () => {
          if (combinedSignal.aborted) throw new Error("Naming session unavailable");
          await options.assertReady("naming.generate", policy);
          if (combinedSignal.aborted) throw new Error("Naming session unavailable");
        };
        try { await assertReady(); }
        catch { return { status: "failed", code: "runtime_policy_unavailable", costMicrousd: 0, providerRequestId: null }; }
        let partialText = ""; let persistedText = ""; let lastFlushAt = 0; let flushFailed = false;
        const flush = async () => {
          if (partialText === persistedText || flushFailed) return;
          try {
            await assertReady();
            await options.appendPartial(job.id, job.leaseToken, partialText);
            persistedText = partialText; lastFlushAt = Date.now();
          } catch (error) { flushFailed = true; throw error; }
        };
        const outcome = await runChatGPTNaming({ input, transport: options.transport, signal: combinedSignal, beforeDispatch: assertReady,
          onPartial: async delta => {
            if (combinedSignal.aborted) throw new Error("Naming session unavailable");
            partialText += delta;
            if (!persistedText || Date.now() - lastFlushAt >= 350 || Buffer.byteLength(partialText.slice(persistedText.length), "utf8") >= 4096) await flush();
          },
        });
        if (outcome.status === "failed" && outcome.partialText) {
          // A known failure can carry completed-item text even without deltas.
          // Preserve it before returning failed; partial text alone is not an
          // uncertain provider outcome. Conflicting streams still need review.
          if (outcome.partialText.startsWith(partialText) && Buffer.byteLength(outcome.partialText, "utf8") <= policy.limits.maxOutputBytes) partialText = outcome.partialText;
          else if (!partialText.startsWith(outcome.partialText)) flushFailed = true;
        }
        try { await flush(); } catch { /* Retain cumulative text in the leased terminal outcome. */ }
        if (outcome.status === "succeeded") {
          // Recheck even when no deltas were emitted; the durable completion RPC
          // separately enforces current lease ownership and publication collisions.
          try { await assertReady(); } catch { flushFailed = true; }
          if (flushFailed || combinedSignal.aborted) return { status: "needs_reconciliation", code: "partial_persistence_unavailable", costMicrousd: 0,
            providerRequestId: outcome.result.responseId, result: { billingMode: "chatgpt_subscription", partialText: outcome.partialText || partialText, recovery: "manual_review" } };
          return { status: "succeeded", result: outcome.result, costMicrousd: 0, providerRequestId: outcome.result.responseId };
        }
        if (outcome.recovery === "view_usage") await options.onQuotaUnavailable?.().catch(() => {});
        const retained = outcome.partialText || partialText;
        const providerRequestId = outcome.responseId ?? outcome.requestId;
        if (outcome.status === "needs_reconciliation" || (retained && flushFailed)) return { status: "needs_reconciliation", code: outcome.code.slice(0, 100), costMicrousd: 0, providerRequestId,
          result: { billingMode: "chatgpt_subscription", partialText: retained, recovery: outcome.recovery } };
        return { status: "failed", code: outcome.code.slice(0, 100), costMicrousd: 0, providerRequestId };
      },
    }];
  } }]]);
}
