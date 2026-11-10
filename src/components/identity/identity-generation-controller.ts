import {
  identityBatchStateSchema,
  identityGenerationIntentSchema,
  type IdentityBatchOverview,
  type IdentityBatchState,
  type IdentityGenerationIntent,
} from "@/domain/identity-jobs";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { AccountRequestError } from "@/components/workspace/account-api";
import { creditsMessage } from "@/components/workspace/credits-message";
import type { AccountIdentityClient } from "./account-identity-client";
import type { IdentityDraftMemory, IdentityGenerationRequest } from "./identity-draft-memory";

export const identityBatchActive = (batch: IdentityBatchState | null): boolean =>
  Boolean(batch && !batch.terminal && batch.status !== "needs_reconciliation");
export const identityBatchUnresolved = (batch: IdentityBatchState | null): boolean =>
  identityBatchActive(batch) || batch?.status === "needs_reconciliation";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Client = Pick<
  AccountIdentityClient,
  "current" | "generation" | "batch" | "batchRequest" | "generate" | "stopBatch" | "closeBatchRequest"
>;
export type IdentityGenerationState = {
  overview: IdentityBatchOverview | null;
  batch: IdentityBatchState | null;
  retained: IdentityGenerationRequest | null;
  busy: "checking" | "starting" | "stopping" | null;
  stopAcknowledgedBatchId: string | null;
  lookup: "unchecked" | "not_found";
  error: string | null;
};
export const EMPTY_IDENTITY_GENERATION: IdentityGenerationState = Object.freeze({
  overview: null,
  batch: null,
  retained: null,
  busy: null,
  stopAcknowledgedBatchId: null,
  lookup: "unchecked",
  error: null,
});

/** Statuses that refuse a request outright. 402 (credits) and 429 (today's limit) come
 * from the generation engine; nothing was admitted or charged for any of them. */
const FINAL_REFUSALS: readonly number[] = [400, 402, 404, 409, 413, 422, 429];
/** What the screen says when a request or check fails. Never a price. */
export function identityGenerationErrorMessage(error: unknown, failure: string): string {
  if (error instanceof AccountRequestError) {
    if (error.status === 409)
      return "Saved inputs changed. Check the latest before starting a new request. Existing systems and the original request are kept.";
    if (error.status === 402) return creditsMessage(null, "Your saved directions are kept.");
    if (error.status === 429)
      return "You've reached today's limit for new directions. Your saved directions are kept. Try again tomorrow.";
  }
  return failure;
}

/** Reads never admit work. Only explicit start/retry send an immutable user intent. */
export function createIdentityGenerationController({
  account,
  projectId,
  client,
  memory,
  canStart,
}: {
  account: VerifiedAccount;
  projectId: string;
  client: Client;
  memory: IdentityDraftMemory;
  canStart(input: IdentityGenerationIntent): boolean;
}) {
  let allowed = canStart;
  let closed = false,
    operation: AbortController | null = null,
    releaseMemory: (() => void) | null = null;
  let state: IdentityGenerationState = {
    ...EMPTY_IDENTITY_GENERATION,
    retained: memory.generationRequest(account.userId, projectId),
  };
  const listeners = new Set<() => void>(),
    current = () => !closed && client.current();
  const retained = () => memory.generationRequest(account.userId, projectId);
  function publish(update: Partial<IdentityGenerationState>) {
    if (current()) {
      state = { ...state, ...update, retained: retained() };
      listeners.forEach((listener) => listener());
    }
  }
  function adopt(input: IdentityBatchState) {
    const batch = identityBatchStateSchema.parse(input),
      previous = state.batch;
    if (batch.ownerId !== account.userId || batch.projectId !== projectId) throw new AccountRequestError(502);
    if (
      previous?.batchId === batch.batchId &&
      (previous.jobId !== batch.jobId ||
        !same(previous.input, batch.input) ||
        !same(previous.intent, batch.intent) ||
        !same(previous.sourceLogo, batch.sourceLogo) ||
        previous.systems.some((system) => !batch.systems.some((next) => next.id === system.id && same(system, next))))
    )
      throw new AccountRequestError(502);
    publish({ batch });
  }
  function recover(batch: IdentityBatchState, input: IdentityGenerationIntent) {
    if (!same(batch.intent, input)) throw new AccountRequestError(502);
    adopt(batch);
    memory.resolveGenerationRequest(account.userId, projectId, input.idempotencyKey);
    publish({ lookup: "unchecked" });
  }
  async function run(
    kind: NonNullable<IdentityGenerationState["busy"]>,
    work: (signal: AbortSignal) => Promise<void>,
    failure: string,
  ) {
    if (!current() || operation) return;
    const controller = new AbortController();
    operation = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    publish({ busy: kind, error: null });
    try {
      await work(controller.signal);
    } catch (error) {
      if (current()) publish({ error: identityGenerationErrorMessage(error, failure) });
    } finally {
      clearTimeout(timeout);
      if (operation === controller) {
        operation = null;
        publish({ busy: null });
      }
    }
  }
  async function lookup(signal: AbortSignal, input: IdentityGenerationIntent) {
    const found = await client.batchRequest(input.idempotencyKey, signal);
    if (!current() || signal.aborted || !found) throw new AccountRequestError(503);
    if (found.status === "found") {
      recover(found.batch, input);
      return true;
    }
    publish({ lookup: "not_found" });
    return false;
  }
  return {
    setPrerequisites(value: typeof canStart) {
      allowed = value;
    },
    getSnapshot: () => (current() ? state : EMPTY_IDENTITY_GENERATION),
    getServerSnapshot: () => EMPTY_IDENTITY_GENERATION,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate() {
      closed = false;
      releaseMemory ??= memory.subscribe(() => publish({}));
      publish({});
    },
    dispose() {
      closed = true;
      operation?.abort();
      operation = null;
      releaseMemory?.();
      releaseMemory = null;
    },
    async refresh() {
      await run(
        "checking",
        async (signal) => {
          const overview = await client.generation(signal);
          if (!current() || signal.aborted || !overview) throw new AccountRequestError(503);
          publish({ overview });
          const original = retained();
          if (original) {
            await lookup(signal, original.input);
            return;
          }
          if (overview.latest) adopt(overview.latest);
        },
        "Generation status could not be checked. Saved systems and any original request are kept.",
      );
    },
    async poll() {
      const batch = state.batch;
      if (!identityBatchActive(batch) || !batch) return;
      await run(
        "checking",
        async (signal) => {
          const value = await client.batch(batch.batchId, signal);
          if (!current() || signal.aborted || !value) throw new AccountRequestError(503);
          adopt(value);
        },
        "The latest generation status could not be checked. The last verified results remain available.",
      );
    },
    async start(value: IdentityGenerationIntent) {
      const input = identityGenerationIntentSchema.parse(value);
      if (
        !current() ||
        operation ||
        retained() ||
        !allowed(input) ||
        !("version" in input) ||
        ![2, 3].includes(input.version) ||
        identityBatchUnresolved(state.batch) ||
        identityBatchUnresolved(state.overview?.latest ?? null)
      )
        return;
      const availability = state.overview?.availability;
      if (
        availability?.status !== "available" ||
        availability.version !== input.version ||
        availability.policyIdentity !== input.acceptedPolicyIdentity
      )
        return;
      if (!memory.retainGenerationRequest({ ownerId: account.userId, projectId, input })) {
        publish({
          error: "The request could not be retained safely. Resolve an earlier pending request before trying again.",
        });
        return;
      }
      await run(
        "starting",
        async (signal) => {
          try {
            const batch = await client.generate(input, signal);
            if (!current() || signal.aborted || !batch) throw new AccountRequestError(503);
            recover(batch, input);
          } catch (error) {
            // A refusal is a final answer: nothing was admitted, so the request is not kept for recovery.
            if (current() && error instanceof AccountRequestError && FINAL_REFUSALS.includes(error.status))
              memory.resolveGenerationRequest(account.userId, projectId, input.idempotencyKey);
            throw error;
          }
        },
        "The generation request could not be confirmed. Check the original request before trying again.",
      );
    },
    async retryOriginal() {
      const original = retained();
      if (!original) return;
      await run(
        "starting",
        async (signal) => {
          if (await lookup(signal, original.input)) return;
          if (!current() || signal.aborted) return;
          const batch = await client.generate(original.input, signal);
          if (!current() || signal.aborted || !batch) throw new AccountRequestError(503);
          recover(batch, original.input);
        },
        "The original request is still unconfirmed. Its saved inputs and request identity are kept.",
      );
    },
    async closeOriginal() {
      const original = retained();
      if (!original) return;
      await run(
        "stopping",
        async (signal) => {
          const result = await client.closeBatchRequest(original.input, signal);
          if (!current() || signal.aborted || !result) throw new AccountRequestError(503);
          if (result.status === "admitted") {
            recover(result.batch, original.input);
            publish({ stopAcknowledgedBatchId: result.batch.batchId });
            return;
          }
          if (
            result.ownerId !== account.userId ||
            result.projectId !== projectId ||
            !same(result.intent, original.input)
          )
            throw new AccountRequestError(502);
          memory.resolveGenerationRequest(account.userId, projectId, original.input.idempotencyKey);
          publish({ lookup: "unchecked" });
        },
        "Stopping the original request could not be confirmed. Its saved intent is kept; check it again before starting another request.",
      );
    },
    async stop() {
      const batch = state.batch;
      if (!batch || !identityBatchUnresolved(batch) || state.stopAcknowledgedBatchId === batch.batchId) return;
      await run(
        "stopping",
        async (signal) => {
          const value = await client.stopBatch(batch, signal);
          if (!current() || signal.aborted || !value) throw new AccountRequestError(503);
          adopt(value);
          publish({ stopAcknowledgedBatchId: value.batchId });
        },
        "Stopping could not be confirmed. Check the request; its saved systems are kept.",
      );
    },
  };
}
export type IdentityGenerationController = ReturnType<typeof createIdentityGenerationController>;
