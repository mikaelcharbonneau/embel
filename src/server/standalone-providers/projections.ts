import "server-only";
import {
  providerTargetSchema,
  providerResultSchema,
  evidenceFreshnessAt,
  type ProviderResult,
  type ProviderProvenance,
} from "@/domain/standalone-provider-evidence";
import { domainCheckSchema, type DomainCheck } from "@/features/domain-workspace/model";
import { evidenceSchema, type HandleEvidence } from "@/features/handles-workspace/domain";
import {
  parseProviderTarget,
  providerTime,
  registrarObservationSchema,
  socialProfileObservationSchema,
  type RegistrarObservation,
  type SocialProfileObservation,
  type DomainTarget,
  type HandleTarget,
} from "./contracts";
import { REGISTRAR_PROVIDER_ID, REGISTRAR_ADAPTER_VERSION, REGISTRAR_SOURCE_URL } from "./registrar-check";
import { SOCIAL_PROVIDER_ID, SOCIAL_ADAPTER_VERSION, SOCIAL_SOURCE_URL } from "./social-profile";

function exactProvenance(
  p: ProviderProvenance,
  now: number,
  providerId: string,
  adapterVersion: string,
  sourceUrl: string,
  maxAge: number,
): boolean {
  return (
    p.providerId === providerId &&
    p.adapterVersion === adapterVersion &&
    p.sourceUrl === sourceUrl &&
    p.rightsBasis === "official_api" &&
    p.checkedAt === p.observedAt &&
    p.freshUntil !== null &&
    Date.parse(p.freshUntil) - Date.parse(p.observedAt) <= maxAge &&
    evidenceFreshnessAt(p, now) === "fresh"
  );
}
/** Compatibility only: this eligibility projection does not reserve or purchase a domain. */
export function toDomainCheck(
  result: ProviderResult<RegistrarObservation>,
  target: DomainTarget,
  now: number,
): DomainCheck | null {
  const desired = providerTargetSchema.safeParse(target),
    evidence = providerResultSchema(registrarObservationSchema).safeParse(result);
  if (
    !desired.success ||
    desired.data.tool !== "domains" ||
    !evidence.success ||
    evidence.data.status !== "observed" ||
    evidence.data.target.tool !== "domains" ||
    evidence.data.target.domain !== desired.data.domain ||
    !exactProvenance(
      evidence.data.provenance,
      now,
      REGISTRAR_PROVIDER_ID,
      REGISTRAR_ADAPTER_VERSION,
      REGISTRAR_SOURCE_URL,
      60_000,
    )
  )
    return null;
  const { provenance, value } = evidence.data;
  // Legacy checks compare millisecond timestamps; finer shared receipts may not fit.
  const projected = domainCheckSchema.safeParse({
    id: provenance.sourceReference,
    domain: desired.data.domain,
    provider: provenance.providerId,
    availability: value.eligibility === "eligible" ? "available" : "unknown",
    checkedAt: provenance.checkedAt,
    validUntil: provenance.freshUntil,
    evidenceReference: provenance.sourceReference,
  });
  return projected.success ? projected.data : null;
}
/** Never emits confirmed_available/taken or any account-ownership declaration. */
export function toHandleEvidence(
  result: ProviderResult<SocialProfileObservation>,
  target: HandleTarget,
  now: number,
): HandleEvidence {
  const desired = parseProviderTarget(target, "handles"),
    time = providerTime(() => now);
  const evidence = providerResultSchema(socialProfileObservationSchema).safeParse(result);
  if (
    evidence.success &&
    evidence.data.status === "observed" &&
    evidence.data.target.tool === "handles" &&
    desired.platform === "youtube" &&
    evidence.data.target.platform === desired.platform &&
    evidence.data.target.handle === desired.handle &&
    exactProvenance(
      evidence.data.provenance,
      now,
      SOCIAL_PROVIDER_ID,
      SOCIAL_ADAPTER_VERSION,
      SOCIAL_SOURCE_URL,
      3_600_000,
    )
  ) {
    const { value, provenance } = evidence.data;
    return evidenceSchema.parse({
      platform: desired.platform,
      handle: desired.handle,
      outcome: value.profile === "not_found" ? "profile_missing" : "unknown",
      authority: "platform_api",
      source: provenance.providerId,
      sourceUrl: provenance.sourceUrl,
      method: provenance.adapterVersion,
      checkedAt: provenance.checkedAt,
      observedAt: provenance.observedAt,
      detail:
        value.profile === "found"
          ? "A profile was observed. Availability, reservation and ownership remain unknown."
          : "No profile was returned by this lookup. Availability, reservation and ownership remain unknown.",
    });
  }
  return evidenceSchema.parse({
    platform: desired.platform,
    handle: desired.handle,
    outcome: "unknown",
    authority: "none",
    source: null,
    sourceUrl: null,
    method: "Provider profile observation",
    checkedAt: null,
    observedAt: time.iso,
    detail: "No fresh, matching profile observation. Availability, reservation and ownership remain unknown.",
  });
}
