import "server-only";
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { type StandaloneLookupResult } from "@/domain/standalone-live-checks";
import { DNS_DOMAIN_PROVIDER, domainCheckSchema } from "@/features/domain-workspace/model";
import { parseProviderTarget, providerTime, type ProviderClock } from "./contracts";

/** Offered extensions whose registries publish no RDAP service in the IANA
 * bootstrap (publication 2026-10-28, reviewed 2026-11-07). */
const zones = new Set(["io", "co", "me", "us"]);
const hostname = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/;

/** Name servers DNS lists for an exact domain; an empty list when it has none. */
export type NameServerLookup = (domain: string, signal: AbortSignal) => Promise<string[]>;
export const resolveNameServers: NameServerLookup = async (domain, signal) => {
  const resolver = new Resolver({ timeout: 2500, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try { return await resolver.resolveNs(domain); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    throw error;
  } finally { signal.removeEventListener("abort", cancel); }
};

/** Where a registry has no RDAP service, its DNS delegation is the public record
 * of a registration: name servers for the exact domain prove it is registered.
 * No delegation proves nothing (a held or reserved name has none), so it is
 * never reported, and this lookup never claims a domain is available. */
export async function lookupDnsDelegation(domain: string, clock: ProviderClock, signal: AbortSignal, resolve: NameServerLookup = resolveNameServers): Promise<StandaloneLookupResult> {
  const target = parseProviderTarget({ tool: "domains", domain }, "domains");
  const labels = target.domain.split("."), zone = labels.at(-1)!;
  if (!zones.has(zone) || labels.length !== 2) return { status: "failed", code: "unsupported_target", retryAfterSeconds: null };
  let servers: string[];
  try { servers = await resolve(target.domain, signal); }
  catch { return { status: "failed", code: signal.aborted ? "cancelled" : "transport", retryAfterSeconds: null }; }
  if (signal.aborted) return { status: "failed", code: "cancelled", retryAfterSeconds: null };
  const delegated = [...new Set(servers.map(server => server.toLowerCase()))].filter(server => hostname.test(server)).sort();
  if (!delegated.length) return { status: "failed", code: "unsupported_target", retryAfterSeconds: null };
  const observed = providerTime(clock);
  const digest = createHash("sha256").update(JSON.stringify({ provider: DNS_DOMAIN_PROVIDER, domain: target.domain, delegated, observedAt: observed.iso })).digest("hex");
  return { status: "domain", quote: null, check: domainCheckSchema.parse({ id: digest, domain: target.domain, provider: DNS_DOMAIN_PROVIDER,
    availability: "taken", checkedAt: observed.iso, validUntil: new Date(observed.ms + 60000).toISOString(), evidenceReference: digest,
    detail: `DNS shows this domain is registered: the .${zone} registry delegates it to name servers. Ownership and purchase are not verified.` }) };
}
