import { appendEvidence, type HandleEntry, type HandleEvidence } from "./domain";

export interface HandleCheckAdapter {
  readonly availability: "unavailable" | "ready";
  readonly label: string;
  check(entry: Pick<HandleEntry, "platform" | "handle">, signal?: AbortSignal): Promise<unknown>;
}
export function unavailableEvidence(
  entry: Pick<HandleEntry, "platform" | "handle">,
  now: string,
  failed = false,
): HandleEvidence {
  return {
    platform: entry.platform,
    handle: entry.handle,
    outcome: failed ? "failed" : "unavailable",
    authority: "none",
    source: null,
    sourceUrl: null,
    method: failed ? "Check failed" : "Not checked on this platform",
    checkedAt: null,
    observedAt: now,
    detail: failed
      ? "The check didn’t finish, so availability is unknown."
      : "Embel can’t check this platform yet, so availability is unknown.",
  };
}
export const unavailableHandleAdapter: HandleCheckAdapter = {
  availability: "unavailable",
  label: "Handle checks aren’t available",
  async check(entry) {
    return unavailableEvidence(entry, new Date().toISOString());
  },
};
export const handleCheckDeadlineMs = 15_000;
export class HandleCheckTimeoutError extends Error {
  constructor(readonly entry: HandleEntry) {
    super("The check took too long. Results so far are kept, and you can try again.");
    this.name = "HandleCheckTimeoutError";
  }
}
export async function checkHandleEntry(
  entry: HandleEntry,
  adapter: HandleCheckAdapter = unavailableHandleAdapter,
  signal?: AbortSignal,
): Promise<HandleEntry> {
  if (signal?.aborted) return entry;
  if (entry.evidence.length >= 100)
    throw new Error(
      "This handle has been checked 100 times, the most Embel keeps. Earlier results are kept and no new check was started.",
    );
  // Never invoke an adapter claiming to be unavailable.
  if (adapter.availability === "unavailable")
    return appendEvidence(entry, unavailableEvidence(entry, new Date().toISOString()));
  const child = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      cancel = () => {
        child.abort();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => {
        child.abort();
        try {
          const failed = {
            ...unavailableEvidence(entry, new Date().toISOString(), true),
            method: "Adapter request timed out",
            detail: "No response arrived within 15 seconds. Availability is unknown.",
          };
          reject(new HandleCheckTimeoutError(appendEvidence(entry, failed)));
        } catch {
          // Clock changes or invalid imported history must never strand the deadline promise.
          reject(new HandleCheckTimeoutError(entry));
        }
      }, handleCheckDeadlineMs);
      // Attach both handlers even when the adapter ignores abort and settles after the deadline.
      Promise.resolve()
        .then(() => {
          if (child.signal.aborted) throw new Error("Cancelled");
          return adapter.check({ platform: entry.platform, handle: entry.handle }, child.signal);
        })
        .then(resolve, reject);
    });
    if (signal?.aborted) return entry;
    return appendEvidence(entry, result);
  } catch (cause) {
    if (signal?.aborted) return entry;
    if (cause instanceof HandleCheckTimeoutError) throw cause;
    // Invalid, wrong-target and failed results cannot retain a current availability claim.
    return appendEvidence(entry, unavailableEvidence(entry, new Date().toISOString(), true));
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}
