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
/** A registrar only reports whether it can sell a new registration. When it cannot, the
 * authoritative registry can confirm an existing registration; otherwise the registrar's
 * own unknown result stands. No price is ever attached to a registry confirmation. */
async function lookupDomain(domain: string, config: StandaloneProviderConfig, fetcher: ProviderFetch, clock: ProviderClock, signal: AbortSignal): Promise<StandaloneLookupResult> {
  const registrar = config.namecom ? lookupNamecom(domain, config.namecom, fetcher, clock, signal) : config.cloudflare ? lookupCloudflare(domain, config.cloudflare, fetcher, clock, signal)
    : config.vercel ? lookupVercel(domain, fetcher, clock, signal) : null;
  if (!registrar) return config.rdap ? await lookupRdap(domain, fetcher, clock, signal) : { status: "failed", code: "unavailable", retryAfterSeconds: null };
  const primary = await registrar;
  // While the registrar asks Embel to wait, the authoritative registry can still
  // confirm a registration (or report no record, shown as not confirmed). Its
  // answer carries the registry's own provider label and never a price.
  if (primary.status === "failed" && primary.code === "rate_limited" && config.rdap && !signal.aborted) {
    const registry = await lookupRdap(domain, fetcher, clock, signal);
    return registry.status === "domain" ? registry : primary;
  }
  if (primary.status !== "domain" || primary.check.availability !== "unknown" || !config.rdap || signal.aborted) return primary;
  const registry = await lookupRdap(domain, fetcher, clock, signal);
  if (registry.status !== "domain" || registry.check.availability !== "taken") return primary;
  // Keep a registrar's resale offer (price and caveats) in front of the registry evidence.
  const resale = primary.check.detail?.startsWith("Not available as a new registration:") ? primary.check.detail : null;
  const combined = resale && `${resale} The authoritative registry returned an exact registration record.`;
  const detail = combined && combined.length <= 500 ? combined : resale ?? registry.check.detail;
  return { ...registry, check: { ...registry.check, detail } };
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
    if (target.tool === "domains") return await lookupDomain(target.domain, config, fetcher, clock, signal);
    if (target.tool === "handles") return target.platform !== "youtube" ? { status: "failed", code: "unsupported_target", retryAfterSeconds: null } : config.youtube ? await lookupYoutube(target, config.youtube.apiKey, fetcher, clock, signal) : { status: "failed", code: "unavailable", retryAfterSeconds: null };
    return config.euipo ? await lookupEuipo(target, config.euipo, fetcher, clock, signal) : { status: "failed", code: "unavailable", retryAfterSeconds: null };
  } catch { return { status: "failed", code: signal.aborted ? "cancelled" : "invalid_response", retryAfterSeconds: null }; }
  finally { release(); }
}
