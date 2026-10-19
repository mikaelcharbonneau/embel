import { logoCapabilitiesSchema, LOGO_CAPABILITIES_MAX_AGE_MS } from "@/domain/logo-capabilities";
import { logoOperationSchema, type LogoOperation } from "@/domain/logo-jobs";
import type { AccountLogoClient } from "./account-logo-client";

const REFRESH_MS = 10_000, REQUEST_TIMEOUT_MS = 8000, SAFETY_MS = 1000, MAX_FUTURE_SKEW_MS = 5000;
type Availability = Readonly<Record<LogoOperation, boolean>>;
export type LogoCapabilitiesState = { status: "unverified" | "loading" | "ready" | "unavailable"; available: Availability };
const unavailable = Object.freeze(Object.fromEntries(logoOperationSchema.options.map(operation => [operation, false])) as Record<LogoOperation, boolean>);
const hidden: LogoCapabilitiesState = Object.freeze({ status: "unverified", available: unavailable });
export const emptyLogoCapabilities = () => hidden;
type Input = { client: Pick<AccountLogoClient, "getLogoCapabilities">; ownerId: string; projectId: string; isCurrent(): boolean; wallNow?(): number; monotonicNow?(): number };

/** Ephemeral advisory hints only. No draft, history or mutation access lives here. */
export function createLogoCapabilitiesController(input: Input) {
  const wallNow = input.wallNow ?? Date.now, monotonicNow = input.monotonicNow ?? (() => performance.now());
  const deadlines = new Map<LogoOperation, { wall: number; monotonic: number }>(), listeners = new Set<() => void>();
  let disposed = false, request: AbortController | null = null, pending: Promise<void> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let state: LogoCapabilitiesState = { status: "loading", available: unavailable };
  const current = () => !disposed && input.isCurrent();
  function isAvailable(operation: LogoOperation) {
    const deadline = deadlines.get(operation), wall = wallNow(), monotonic = monotonicNow();
    return !!(current() && deadline && Number.isFinite(wall) && Number.isFinite(monotonic) && wall < deadline.wall && monotonic < deadline.monotonic);
  }
  function publish(status: LogoCapabilitiesState["status"]) {
    if (!current()) return;
    const available = Object.freeze(Object.fromEntries(logoOperationSchema.options.map(operation => [operation, isAvailable(operation)])) as Record<LogoOperation, boolean>);
    state = Object.freeze({ status, available }); for (const listener of listeners) listener();
  }
  function expire() {
    clearTimeout(expiryTimer); expiryTimer = undefined;
    if (!current()) return;
    publish(state.status);
    const remaining = [...deadlines.values()].map(value => Math.min(value.monotonic - monotonicNow(), value.wall - wallNow())).filter(value => value > 0);
    if (remaining.length) expiryTimer = setTimeout(expire, Math.ceil(Math.min(...remaining)));
  }
  function refresh(): Promise<void> {
    if (!current()) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(refreshTimer); publish("loading");
    const controller = new AbortController(); request = controller;
    const startWall = wallNow(), startMonotonic = monotonicNow();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const aborted = new Promise<null>(resolve => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    pending = (async () => {
      try {
        const raw = await Promise.race([Promise.resolve().then(() => current() && request === controller && !controller.signal.aborted ? input.client.getLogoCapabilities(controller.signal) : null), aborted]);
        if (!current() || request !== controller) return;
        if (controller.signal.aborted || !raw) { deadlines.clear(); publish("unavailable"); return; }
        const parsed = logoCapabilitiesSchema.safeParse(raw), endWall = wallNow(), endMonotonic = monotonicNow();
        deadlines.clear();
        const elapsed = Math.max(endMonotonic - startMonotonic, endWall - startWall, 0);
        if (!parsed.success || parsed.data.ownerId !== input.ownerId || parsed.data.projectId !== input.projectId
          || ![startWall, startMonotonic, endWall, endMonotonic, elapsed].every(Number.isFinite) || endMonotonic < startMonotonic) { publish("unavailable"); return; }
        const observed = Date.parse(parsed.data.observedAt);
        if (observed > startWall + elapsed + MAX_FUTURE_SKEW_MS) { publish("unavailable"); return; }
        for (const operation of logoOperationSchema.options) {
          const value = parsed.data.operations[operation]; if (value.status !== "available") continue;
          // Start the lifetime at request dispatch, subtract all transit time and
          // any already-known server age. Deduct the entire tolerated slow-client
          // skew too, so an apparently future observation cannot hide that age.
          const remaining = Math.min(LOGO_CAPABILITIES_MAX_AGE_MS, Date.parse(value.expiresAt) - observed)
            - Math.max(0, startWall - observed) - elapsed - MAX_FUTURE_SKEW_MS - SAFETY_MS;
          if (remaining > 0) deadlines.set(operation, { wall: endWall + remaining, monotonic: endMonotonic + remaining });
        }
        publish("ready"); expire();
      } catch { if (current() && request === controller) { deadlines.clear(); publish("unavailable"); } }
      finally {
        clearTimeout(timeout);
        if (request === controller) { request = null; pending = null; if (current()) refreshTimer = setTimeout(() => { void refresh(); }, REFRESH_MS); }
      }
    })();
    return pending;
  }
  return { getSnapshot: () => current() ? state : hidden, isAvailable, refresh,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; request?.abort(); request = null; pending = null; clearTimeout(refreshTimer); clearTimeout(expiryTimer); deadlines.clear(); listeners.clear(); },
  };
}
export type LogoCapabilitiesController = ReturnType<typeof createLogoCapabilitiesController>;
