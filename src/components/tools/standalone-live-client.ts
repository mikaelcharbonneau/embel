import { z } from "zod";
import {
  standaloneCapabilitiesSchema,
  standaloneLookupResponseSchema,
  lookupFailureMessage,
  type StandaloneCapabilities,
  type StandaloneLookupInput,
  type TrademarkLookup,
} from "@/domain/standalone-live-checks";
import {
  type DomainSearchAdapter,
  type DomainQuote,
  DomainLookupError,
  quoteBlockReason,
  acceptedDomainCheckProvider,
  REGISTRY_DOMAIN_PROVIDER,
} from "@/features/domain-workspace/model";
import { type HandleCheckAdapter, unavailableEvidence } from "@/features/handles-workspace/adapters";

export type LiveLookupBinding = { ownerId: string; isCurrent: () => boolean; signal: AbortSignal };
type TrademarkLookupAdapter = {
  ready: boolean;
  search(input: Extract<StandaloneLookupInput, { tool: "trademarks" }>, signal: AbortSignal): Promise<TrademarkLookup>;
};
const abortError = () => new Error("This account lookup is no longer current.");

/** Bound fetch, decoded bytes and publication even when a transport ignores cancellation. */
async function request<T>(
  schema: z.ZodType<T>,
  binding: LiveLookupBinding,
  caller: AbortSignal,
  body?: StandaloneLookupInput,
): Promise<T> {
  if (!binding.isCurrent() || binding.signal.aborted || caller.aborted) throw abortError();
  const child = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stop!: (reason: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  const abort = () => {
    stop(abortError());
    child.abort();
    void reader?.cancel().catch(() => {});
  };
  const timer = setTimeout(() => {
    stop(new Error("The lookup timed out. You can try again."));
    child.abort();
    void reader?.cancel().catch(() => {});
  }, 20000);
  binding.signal.addEventListener("abort", abort, { once: true });
  caller.addEventListener("abort", abort, { once: true });
  try {
    const work = async () => {
      if (child.signal.aborted) throw abortError();
      const response = await fetch("/api/standalone-checks", {
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json", "X-Embel-Account": binding.ownerId } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: child.signal,
      });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
        void response.body?.cancel().catch(() => {});
        throw new Error(
          response.status === 401
            ? "Sign in again before checking providers."
            : "The lookup service could not be reached.",
        );
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error("The lookup response could not be verified.");
      const bytes = new Uint8Array(262144);
      let size = 0;
      for (let chunks = 0; ; chunks++) {
        if (child.signal.aborted || chunks >= 2048) throw abortError();
        const next = await reader.read();
        if (next.done) break;
        if (size + next.value.byteLength > bytes.byteLength) throw new Error("The lookup response exceeded its limit.");
        bytes.set(next.value, size);
        size += next.value.byteLength;
      }
      let parsed: ReturnType<typeof schema.safeParse>;
      try {
        parsed = schema.safeParse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))),
        );
      } catch {
        throw new Error("The lookup response could not be verified.");
      }
      if (!parsed.success) throw new Error("The lookup response could not be verified.");
      return parsed.data;
    };
    const result = await Promise.race([work(), stopped]);
    if (!binding.isCurrent() || binding.signal.aborted || caller.aborted) throw abortError();
    return result;
  } finally {
    clearTimeout(timer);
    binding.signal.removeEventListener("abort", abort);
    caller.removeEventListener("abort", abort);
    child.abort();
    void reader?.cancel().catch(() => {});
    try {
      reader?.releaseLock();
    } catch {}
  }
}
export async function loadStandaloneCapabilities(binding: LiveLookupBinding): Promise<StandaloneCapabilities> {
  const result = await request(standaloneCapabilitiesSchema, binding, binding.signal);
  if (result.ownerId !== binding.ownerId) throw abortError();
  return result;
}
export function createStandaloneLiveAdapters(
  capabilities: StandaloneCapabilities,
  binding: LiveLookupBinding,
): { domains: DomainSearchAdapter; handles: HandleCheckAdapter; trademarks: TrademarkLookupAdapter } {
  const prices = new Map<
    string,
    { check: Extract<Awaited<ReturnType<typeof lookup>>, { status: "domain" }>["check"]; quote: DomainQuote | null }
  >();
  async function lookup(input: StandaloneLookupInput, signal: AbortSignal) {
    const response = await request(standaloneLookupResponseSchema, binding, signal, input);
    if (response.ownerId !== binding.ownerId) throw abortError();
    if (response.result.status === "failed")
      throw new DomainLookupError(
        response.result.code === "rate_limited" && response.result.retryAfterSeconds !== null
          ? `The lookup limit was reached. Wait ${response.result.retryAfterSeconds} seconds before checking again.`
          : lookupFailureMessage[response.result.code],
        response.result.code === "rate_limited" ? (response.result.retryAfterSeconds ?? 60) : null,
      );
    return response.result;
  }
  const provider =
    capabilities.domains === "namecom"
      ? "namecom_core"
      : capabilities.domains === "cloudflare"
        ? "cloudflare_registrar"
        : capabilities.domains === "vercel"
          ? "vercel_registrar"
          : REGISTRY_DOMAIN_PROVIDER;
  const hasPrices =
    capabilities.domains === "namecom" || capabilities.domains === "cloudflare" || capabilities.domains === "vercel";
  return {
    domains:
      capabilities.domains === "unavailable"
        ? {
            status: "unavailable",
            reason: "Domain checks aren’t available right now. You can still list domains to look up yourself.",
          }
        : {
            status: "ready",
            provider,
            quotesWithCheck: hasPrices,
            description:
              capabilities.domains === "namecom"
                ? "Availability and prices come from Name.com, in USD. Aftermarket and expiring domains show as Unknown. Public registry and DNS records confirm taken domains. Only domain names are sent to Name.com and to those records."
                : capabilities.domains === "rdap"
                  ? "Public registry and DNS records confirm taken domains. Availability and prices need a connected registrar."
                  : capabilities.domains === "vercel"
                    ? "Availability and prices come from Vercel, in USD. Public registry and DNS records confirm taken domains. Only domain names are sent to Vercel and to those records."
                    : "Availability and yearly prices come from Cloudflare.",
            async check(domain, signal) {
              prices.delete(domain);
              const result = await lookup({ tool: "domains", domain }, signal);
              if (
                result.status !== "domain" ||
                result.check.domain !== domain ||
                !acceptedDomainCheckProvider(result.check, provider) ||
                (result.check.provider !== provider && result.quote !== null)
              )
                throw new Error("The lookup did not match this domain.");
              if (result.quote && quoteBlockReason(result.quote, result.check, Date.now()) !== null)
                throw new Error("The price did not match this domain check.");
              if (prices.size >= 200) prices.delete(prices.keys().next().value!);
              prices.set(domain, { check: result.check, quote: result.quote });
              return result.check;
            },
            ...(hasPrices
              ? {
                  async quote(domain: string, checkId: string, signal: AbortSignal) {
                    if (!binding.isCurrent() || binding.signal.aborted || signal.aborted) throw abortError();
                    const result = prices.get(domain);
                    if (
                      !result?.quote ||
                      result.check.id !== checkId ||
                      quoteBlockReason(result.quote, result.check, Date.now()) !== null
                    )
                      throw new Error("No current matching registrar price. Check this domain again.");
                    return result.quote;
                  },
                }
              : {}),
          },
    handles: {
      availability: capabilities.youtube ? "ready" : "unavailable",
      label: "Looks up existing YouTube profiles only",
      async check(entry, signal = new AbortController().signal) {
        if (!binding.isCurrent() || binding.signal.aborted || signal.aborted) throw abortError();
        if (!capabilities.youtube || entry.platform !== "youtube")
          return unavailableEvidence(entry, new Date().toISOString());
        const result = await lookup({ tool: "handles", ...entry }, signal);
        if (
          result.status !== "handle" ||
          result.evidence.platform !== entry.platform ||
          result.evidence.handle !== entry.handle
        )
          throw new Error("The lookup did not match this handle.");
        return result.evidence;
      },
    },
    trademarks: {
      ready: capabilities.euipo,
      async search(input, signal) {
        if (!capabilities.euipo) throw new Error("EUIPO research is not connected.");
        const result = await lookup(input, signal);
        if (result.status !== "trademark" || JSON.stringify(result.research.query) !== JSON.stringify(input))
          throw new Error("The lookup did not match these search criteria.");
        return result.research;
      },
    },
  };
}
