/** Retrying an idempotent local persistence operation is not a provider retry.
 * Callers must use the same immutable identity and payload on every attempt. */
export async function retryLocalPersistence<T>(work: () => Promise<T>, signal: AbortSignal, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)), allowInitialWriteAfterAbort = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted && !(attempt === 0 && allowInitialWriteAfterAbort)) throw new Error("local_recovery_cancelled");
    try { return await work(); }
    catch (error) {
      const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : null;
      // Validation, conflicts, permissions and unknown errors are not retried.
      const transient = typeof code === "string" && /^(08000|08003|08006|40001|40P01|53300|57P03|ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/u.test(code);
      if (!transient || attempt >= 2 || signal.aborted) throw error;
      await wait(100 * 2 ** attempt);
    }
  }
}

export class LocalNamingFailure extends Error {
  constructor(readonly phase: "planning" | "publication", cause: unknown) {
    super(`local_${phase}_failed`, { cause });
  }
}

/** Redacted diagnostics: no exception messages, prompts, payloads or secrets. */
export function reportNamingFailure(error: unknown, fallback: string): void {
  const cause = error instanceof LocalNamingFailure ? error.cause : error;
  const code = cause && typeof cause === "object" ? Object.getOwnPropertyDescriptor(cause, "code")?.value : null;
  console.warn(JSON.stringify({ event: "naming_local_failure", phase: error instanceof LocalNamingFailure ? error.phase : fallback,
    errorClass: typeof code === "string" && /^(08000|08003|08006|40001|40P01|53300|57P03|22023|23505|42501|ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/u.test(code) ? code : "unclassified" }));
}
