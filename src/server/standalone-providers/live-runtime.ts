import "server-only";
import { type StandaloneCapabilities, type StandaloneLookupInput, type StandaloneLookupResult } from "@/domain/standalone-live-checks";
import { standaloneProviderConfig, type StandaloneProviderConfig } from "./live-config";
import { lookupRdap } from "./rdap";
import { lookupCloudflare } from "./cloudflare-live";
import { lookupNamecom } from "./namecom-live";
import { lookupVercel } from "./vercel-live";
import { lookupYoutube } from "./youtube-live";
import { lookupEuipo } from "./euipo-live";
import { type ProviderClock, type ProviderFetch } from "./contracts";

export function standaloneCapabilities(ownerId: string, config = standaloneProviderConfig()): StandaloneCapabilities {
  return { ownerId, domains: config.namecom ? "namecom" : config.cloudflare ? "cloudflare" : config.vercel ? "vercel" : config.rdap ? "rdap" : "unavailable", youtube: !!config.youtube, euipo: !!config.euipo };
}
/** Process-local abuse guard, not a distributed billing policy. These are read-only lookups. */
export function createLookupAdmission(clock: ProviderClock = Date.now) {
  const owners = new Map<string, { start: number; count: number; active: boolean }>();
  let total = { start: clock(), count: 0 };
  return (ownerId: string): (() => void) | null => {
    const now = clock();
    for (const [id, bucket] of owners) if (!bucket.active && (now - bucket.start >= 60000 || now < bucket.start)) owners.delete(id);
    if (now - total.start >= 60000 || now < total.start) total = { start: now, count: 0 };
    let bucket = owners.get(ownerId);
    if (bucket?.active || (bucket?.count ?? 0) >= 30 || total.count >= 120 || !bucket && owners.size >= 500) return null;
    if (!bucket) { bucket = { start: now, count: 0, active: false }; owners.set(ownerId, bucket); }
    bucket.count++; bucket.active = true; total.count++;
    return () => { bucket.active = false; };
  };
}
const admit = createLookupAdmission();
// Stable identity lets simultaneous exact public-domain reads share one bounded request.
const providerFetch: ProviderFetch = request => fetch(request);
export async function runStandaloneLookup(ownerId: string, target: StandaloneLookupInput, signal: AbortSignal, deps: { config?: StandaloneProviderConfig; fetch?: ProviderFetch; clock?: ProviderClock; admit?: ReturnType<typeof createLookupAdmission> } = {}): Promise<StandaloneLookupResult> {
  if (signal.aborted) return { status: "failed", code: "cancelled", retryAfterSeconds: null };
  const config = deps.config ?? standaloneProviderConfig(), fetcher = deps.fetch ?? providerFetch, clock = deps.clock ?? Date.now;
  const release = (deps.admit ?? admit)(ownerId);
  if (!release) return { status: "failed", code: "rate_limited", retryAfterSeconds: 60 };
  try {
    if (target.tool === "domains") return config.namecom ? await lookupNamecom(target.domain, config.namecom, fetcher, clock, signal) : config.cloudflare ? await lookupCloudflare(target.domain, config.cloudflare, fetcher, clock, signal) : config.vercel ? await lookupVercel(target.domain, fetcher, clock, signal) : config.rdap ? await lookupRdap(target.domain, fetcher, clock, signal) : { status: "failed", code: "unavailable", retryAfterSeconds: null };
    if (target.tool === "handles") return target.platform !== "youtube" ? { status: "failed", code: "unsupported_target", retryAfterSeconds: null } : config.youtube ? await lookupYoutube(target, config.youtube.apiKey, fetcher, clock, signal) : { status: "failed", code: "unavailable", retryAfterSeconds: null };
    return config.euipo ? await lookupEuipo(target, config.euipo, fetcher, clock, signal) : { status: "failed", code: "unavailable", retryAfterSeconds: null };
  } catch { return { status: "failed", code: signal.aborted ? "cancelled" : "invalid_response", retryAfterSeconds: null }; }
  finally { release(); }
}
