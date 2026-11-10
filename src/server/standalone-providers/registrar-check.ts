import "server-only";
import { z } from "zod";
import { providerDomainSchema, providerResultSchema, type ProviderResult } from "@/domain/standalone-provider-evidence";
import { requestProviderJson } from "./bounded-request";
import {
  accountIdSchema,
  parseProviderTarget,
  providerFailure,
  providerTime,
  registrarObservationSchema,
  registrarReasons,
  transportDependenciesSchema,
  type ProviderFetch,
  type ProviderClock,
  type RegistrarObservation,
} from "./contracts";

export const REGISTRAR_PROVIDER_ID = "cloudflare_registrar";
export const REGISTRAR_ADAPTER_VERSION = "cloudflare-check-v1";
export const REGISTRAR_SOURCE_URL = "https://developers.cloudflare.com/api/resources/registrar/methods/check/";
const wireDomain = z
  .strictObject({
    name: providerDomainSchema,
    registrable: z.boolean(),
    reason: z.enum(registrarReasons).optional(),
    tier: z.enum(["standard", "premium"]).optional(),
    pricing: z
      .strictObject({
        currency: z.string().min(1).max(10),
        registration_cost: z.string().min(1).max(100),
        renewal_cost: z.string().min(1).max(100),
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.registrable ? value.reason === undefined && value.tier !== "premium" : value.reason !== undefined,
    "Conflicting eligibility",
  );
export const registrarWireSchema = z.strictObject({
  success: z.literal(true),
  errors: z.array(z.unknown()).max(0),
  messages: z.array(z.unknown()).max(100),
  result: z.strictObject({ domains: z.array(wireDomain).length(1) }),
});

/** A documented eligibility check exemplar. No credentials, wiring or transaction methods. */
export function createRegistrarCheckContract(deps: { fetch: ProviderFetch; clock: ProviderClock; accountId: string }): {
  check(domain: string, signal: AbortSignal): Promise<ProviderResult<RegistrarObservation>>;
} {
  const parsed = transportDependenciesSchema.extend({ accountId: accountIdSchema }).safeParse(deps);
  if (!parsed.success) throw new TypeError("Invalid registrar configuration");
  const config = parsed.data;
  providerTime(config.clock);
  return {
    async check(domain, signal) {
      const target = parseProviderTarget({ tool: "domains", domain }, "domains");
      const response = await requestProviderJson(
        { endpoint: "cloudflare_check", accountId: config.accountId, domain: target.domain },
        { fetch: config.fetch, clock: config.clock },
        signal,
      );
      if (response.status === "failed") return { ...response, target };
      if (signal.aborted) return providerFailure(target, "cancelled", response.observedAt);
      const decoded = registrarWireSchema.safeParse(response.body);
      if (!decoded.success || decoded.data.result.domains[0]!.name !== target.domain)
        return providerFailure(target, "invalid_response", response.observedAt);
      const record = decoded.data.result.domains[0]!;
      return providerResultSchema(registrarObservationSchema).parse({
        status: "observed",
        target,
        value: record.registrable
          ? { eligibility: "eligible", reason: "eligible" }
          : { eligibility: "ineligible", reason: record.reason! },
        provenance: {
          providerId: REGISTRAR_PROVIDER_ID,
          adapterVersion: REGISTRAR_ADAPTER_VERSION,
          contractVersion: 1,
          sourceUrl: REGISTRAR_SOURCE_URL,
          sourceReference: response.responseSha256,
          providerRequestId: response.providerRequestId,
          checkedAt: response.observedAt,
          observedAt: response.observedAt,
          freshUntil: new Date(Date.parse(response.observedAt) + 60_000).toISOString(),
          rightsBasis: "official_api",
        },
      });
    },
  };
}
