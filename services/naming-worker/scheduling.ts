import type { runOneJob } from "../../worker/runner";

export const NAMING_POLL_INTERVALS = Object.freeze({
  claimIdleBaseMs: 1_000, claimIdleMaxMs: 5_000, preferencesMs: 15_000, expiryMs: 15_000,
  errorBaseMs: 1_000, errorMaxMs: 60_000, followerMs: 5_000,
});
export type NamingCycle = Awaited<ReturnType<typeof runOneJob>>;
type Operation = "preferences" | "expiry" | "claim";

/** Ref'd, abortable wait: an idle daemon stays alive without retaining a client. */
export function waitForNamingPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Bounded equal jitter. A caller cannot accidentally turn a failed RPC into a
 * zero-delay loop; the ceiling remains at most one minute. */
export function namingErrorDelay(attempt: number, random: () => number = Math.random): number {
  const sample = random(), unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 1;
  const cap = Math.min(NAMING_POLL_INTERVALS.errorMaxMs,
    NAMING_POLL_INTERVALS.errorBaseMs * 2 ** Math.min(16, Math.max(0, attempt)));
  return Math.ceil(cap * (0.8 + unit * 0.2));
}

/** Naming-only scheduling. One maintenance lane serializes attestation/expiry;
 * a separate single runner keeps maintenance due during long provider stages.
 * A local authority snapshot only suppresses work. SQL remains authoritative
 * under its mutation locks; this scheduler never authorizes or retries creates. */
export async function runNamingPolling(options: {
  signal: AbortSignal;
  generation(): number | null;
  attestPreferences(): Promise<unknown>;
  expireLeases(): Promise<unknown>;
  runJob(): Promise<NamingCycle>;
  onError?(operation: Operation): void;
  onJob?(state: NamingCycle): void;
  now?: () => number;
  random?: () => number;
}): Promise<void> {
  const { signal } = options, now = options.now ?? (() => performance.now());
  const diagnostic = (operation: Operation) => { try { options.onError?.(operation); } catch { /* Diagnostics carry no authority. */ } };
  let seenGeneration: number | null | undefined, bootstrappedGeneration: number | null = null, revision = 0;
  let maintenanceWake = new AbortController(), jobWake = new AbortController();
  const wakeMaintenance = () => { maintenanceWake.abort(); maintenanceWake = new AbortController(); };
  const wakeJobs = () => { jobWake.abort(); jobWake = new AbortController(); };
  const synchronize = () => {
    const generation = options.generation();
    if (generation !== seenGeneration) {
      seenGeneration = generation; bootstrappedGeneration = null; revision++;
      wakeMaintenance(); wakeJobs();
    }
    return generation;
  };
  const maintenance = async () => {
    const due = { preferences: now(), expiry: now() }, failures = { preferences: 0, expiry: 0 };
    let scheduledRevision = revision;
    while (!signal.aborted) {
      const generation = synchronize();
      if (generation === null) { await waitForNamingPoll(NAMING_POLL_INTERVALS.followerMs, AbortSignal.any([signal, maintenanceWake.signal])); continue; }
      if (scheduledRevision !== revision) {
        due.preferences = due.expiry = now(); failures.preferences = failures.expiry = 0; scheduledRevision = revision;
      }
      const operation = due.preferences <= due.expiry ? "preferences" : "expiry";
      const remaining = due[operation] - now();
      if (remaining > 0) { await waitForNamingPoll(Math.min(remaining, NAMING_POLL_INTERVALS.followerMs), AbortSignal.any([signal, maintenanceWake.signal])); continue; }
      try {
        await (operation === "preferences" ? options.attestPreferences() : options.expireLeases());
        failures[operation] = 0;
        // Schedule from completion, never replay a backlog of missed ticks.
        due[operation] = now() + (operation === "preferences" ? NAMING_POLL_INTERVALS.preferencesMs : NAMING_POLL_INTERVALS.expiryMs);
      } catch {
        diagnostic(operation);
        due[operation] = now() + namingErrorDelay(failures[operation]++, options.random);
      } finally {
        // Bootstrap each acquired generation. A late old-generation result may
        // never release the new owner's claim lane. SQL still rechecks authority.
        if (operation === "preferences" && synchronize() === generation && !signal.aborted && bootstrappedGeneration !== generation) {
          bootstrappedGeneration = generation; wakeJobs();
        }
      }
    }
  };
  const jobs = async () => {
    let idle = 0, failures = 0;
    let scheduledGeneration: number | null | undefined;
    while (!signal.aborted) {
      const generation = synchronize();
      if (generation !== scheduledGeneration) { idle = failures = 0; scheduledGeneration = generation; }
      if (generation === null || bootstrappedGeneration !== generation) {
        await waitForNamingPoll(NAMING_POLL_INTERVALS.followerMs, AbortSignal.any([signal, jobWake.signal])); continue;
      }
      let pause = 0;
      try {
        const state = await options.runJob();
        try { options.onJob?.(state); } catch { /* A diagnostic sink cannot retry work. */ }
        if (synchronize() !== generation) { idle = failures = 0; continue; }
        if (state === "lease_lost") {
          idle = 0; pause = namingErrorDelay(failures++, options.random);
        } else {
          failures = 0;
          if (state === "idle") pause = Math.min(NAMING_POLL_INTERVALS.claimIdleMaxMs,
            NAMING_POLL_INTERVALS.claimIdleBaseMs * 2 ** Math.min(3, idle++));
          else idle = 0;
        }
      } catch {
        if (synchronize() !== generation) { idle = failures = 0; continue; }
        // runOneJob contains execution outcomes. A rejected cycle is a claim /
        // control-plane failure, not permission to repeat a provider request.
        idle = 0; diagnostic("claim"); pause = namingErrorDelay(failures++, options.random);
      }
      await waitForNamingPoll(pause, AbortSignal.any([signal, jobWake.signal]));
    }
  };
  await Promise.all([maintenance(), jobs()]);
}
