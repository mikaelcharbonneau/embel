import {
  identityBatchStateSchema,
  identityGenerationIntentSchema,
  type IdentityBatchOverview,
  type IdentityBatchState,
  type IdentityGenerationIntent,
} from "@/domain/identity-jobs";
import {
  GENERATION_UNAVAILABLE_CODE,
  startRefusal,
  stepView,
  type RunPhase,
  type StepProblem,
  type StepView,
} from "@/domain/generation-run";
import { UPDATES_DELAYED } from "@/domain/generation-words";
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
  /** What `error` is about, so the screen can decide what to offer with it (`identityStepView`). */
  problem: StepProblem | null;
};
export const EMPTY_IDENTITY_GENERATION: IdentityGenerationState = Object.freeze({
  overview: null,
  batch: null,
  retained: null,
  busy: null,
  stopAcknowledgedBatchId: null,
  lookup: "unchecked",
  error: null,
  problem: null,
});

/** The round's phase in the words every step screen shares. A round is stored as a job, whose stop
 * request is a status; a round that may still be working (unresolved) counts as working. */
const identityRunPhase = (batch: IdentityBatchState | null): RunPhase | null =>
  !batch || !identityBatchUnresolved(batch) ? null : batch.status === "cancel_requested" ? "stopping" : "running";
/** What the person can do on Creative direction: the one decision shared with Naming and Logo
 * (docs/state-machines.md). Stopping is read from the round itself, so every tab shows the same. */
export function identityStepView(
  state: Pick<
    IdentityGenerationState,
    "overview" | "batch" | "retained" | "busy" | "stopAcknowledgedBatchId" | "problem"
  >,
): StepView {
  const batch = state.batch ?? state.overview?.latest ?? null,
    phase = identityRunPhase(batch);
  return stepView({
    // A Stop the server acknowledged without changing the status (an uncertain round) is stopping too.
    phase: phase && batch?.batchId === state.stopAcknowledgedBatchId ? "stopping" : phase,
    loaded: Boolean(state.overview),
    // A request kept from an earlier visit is still unconfirmed.
    problem: state.problem ?? (state.retained && !phase ? { during: "start", httpStatus: null } : null),
    sending: state.busy === "starting" ? "start" : state.busy === "stopping" ? "stop" : null,
  });
}
/** Creative direction is switched off, or cannot start for a reason the person cannot change here. */
export const IDENTITY_GENERATION_UNAVAILABLE = "Generation is temporarily unavailable. Your saved work is kept.";
/**
 * What Creative direction says about generation. A status check that fails while the round still works is the
 * quiet note Naming and Logo show (docs/state-machines.md): the screen keeps checking and Stop stays, so it is
 * never shown as the round's error.
 */
export function identityGenerationMessage(
  state: Parameters<typeof identityStepView>[0] & Pick<IdentityGenerationState, "error">,
): { error: string | null; note: string | null } {
  const delayed = identityStepView(state).message === "updates_delayed";
  return { error: delayed ? null : state.error, note: delayed ? UPDATES_DELAYED : null };
}
/** What the screen says when a request or check fails. Never a price. */
export function identityGenerationErrorMessage(error: unknown, failure: string): string {
  if (error instanceof AccountRequestError) {
    // Switched off: the server sends this code only when nothing was admitted.
    if (error.code === GENERATION_UNAVAILABLE_CODE) return IDENTITY_GENERATION_UNAVAILABLE;
    if (error.status === 409)
      return "Saved inputs changed. Check the latest before starting a new request. Existing systems and the original request are kept.";
    if (error.status === 402) return creditsMessage(null, "Your saved directions are kept.");
    if (error.status === 429)
      return "You’ve reached today’s limit for new directions. Your saved directions are kept. Try again tomorrow.";
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
    /** Whether the running operation is only a status check: a check yields to Stop or Start. */
    checking = false,
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
    // A failed Stop is settled once the round itself says it is stopping or over.
    const settled = state.problem?.during === "stop" && identityRunPhase(batch) !== "running";
    publish({ batch, ...(settled ? { error: null, problem: null } : {}) });
  }
  function recover(batch: IdentityBatchState, input: IdentityGenerationIntent) {
    if (!same(batch.intent, input)) throw new AccountRequestError(502);
    adopt(batch);
    memory.resolveGenerationRequest(account.userId, projectId, input.idempotencyKey);
    publish({ lookup: "unchecked" });
  }
  /** Stop and Start wait for nothing but each other: a status check in flight yields to them. */
  const occupied = () => operation !== null && !checking;
  async function run(
    kind: NonNullable<IdentityGenerationState["busy"]>,
    work: (signal: AbortSignal) => Promise<void>,
    failure: string,
    during: (error: unknown) => StepProblem,
    /** A background check: it leaves what is on screen alone unless it has news. */
    quiet = false,
  ) {
    if (!current()) return;
    if (operation) {
      // Two starts never run at once, and a check never interrupts anything.
      if (kind === "checking" || !checking) return;
      operation.abort();
    }
    const controller = new AbortController();
    operation = controller;
    checking = kind === "checking";
    const timeout = setTimeout(() => controller.abort(), 30_000);
    publish({ busy: kind, ...(quiet ? {} : { error: null, problem: null }) });
    try {
      await work(controller.signal);
      if (quiet && operation === controller && state.problem?.during === "check")
        publish({ error: null, problem: null });
    } catch (error) {
      // A check that yielded has nothing to report.
      if (current() && operation === controller)
        publish({ error: identityGenerationErrorMessage(error, failure), problem: during(error) });
    } finally {
      clearTimeout(timeout);
      if (operation === controller) {
        operation = null;
        checking = false;
        publish({ busy: null });
      }
    }
  }
  const startProblem = (error: unknown): StepProblem => ({
    during: "start",
    httpStatus: error instanceof AccountRequestError ? error.status : null,
    code: error instanceof AccountRequestError ? (error.code ?? null) : null,
  });
  const stopProblem = (): StepProblem => ({ during: "stop" });
  /** Sends the request, first or again with its same key, and adopts the round it started. */
  async function send(input: IdentityGenerationIntent, signal: AbortSignal) {
    try {
      const batch = await client.generate(input, signal);
      if (!current() || signal.aborted || !batch) throw new AccountRequestError(503);
      recover(batch, input);
    } catch (error) {
      // A final refusal (startRefusal) admitted nothing, so the request is not kept for recovery.
      if (current() && error instanceof AccountRequestError && startRefusal(error.status, error.code) === "final")
        memory.resolveGenerationRequest(account.userId, projectId, input.idempotencyKey);
      throw error;
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
        () => ({ during: state.overview ? "check" : "load" }),
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
        () => ({ during: "check" }),
        true,
      );
    },
    async start(value: IdentityGenerationIntent) {
      const input = identityGenerationIntentSchema.parse(value);
      if (
        !current() ||
        occupied() ||
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
        (signal) => send(input, signal),
        "The generation request could not be confirmed. Check the original request before trying again.",
        startProblem,
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
          await send(original.input, signal);
        },
        "The original request is still unconfirmed. Its saved inputs and request identity are kept.",
        startProblem,
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
        stopProblem,
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
        stopProblem,
      );
    },
  };
}
export type IdentityGenerationController = ReturnType<typeof createIdentityGenerationController>;
