import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { toDomainCheck, toHandleEvidence } from "@/server/standalone-providers/projections";
import { createRegistrarCheckContract } from "@/server/standalone-providers/registrar-check";
import { createSocialProfileContract } from "@/server/standalone-providers/social-profile";
import { createTrademarkSearchContract } from "@/server/standalone-providers/trademark-search";
import { evidenceSchema } from "@/features/handles-workspace/domain";
import type {
  DomainTarget,
  HandleTarget,
  RegistrarObservation,
  SocialProfileObservation,
} from "@/server/standalone-providers/contracts";
import { providerResultSchema, type ProviderResult } from "@/domain/standalone-provider-evidence";
import { registrarObservationSchema } from "@/server/standalone-providers/contracts";
import { accountId, clock, domain, json, noNetwork, NOW, signal } from "./fixtures";
const domainTarget: DomainTarget = { tool: "domains", domain };
const handleTarget: HandleTarget = { tool: "handles", platform: "youtube", handle: "fixture" };
const registrar = async (registrable = true) =>
  createRegistrarCheckContract({
    accountId,
    clock,
    fetch: async () =>
      json({
        success: true,
        errors: [],
        messages: [],
        result: { domains: [{ name: domain, registrable, ...(registrable ? {} : { reason: "domain_premium" }) }] },
      }),
  }).check(domain, signal());
const social = async (found = true) =>
  createSocialProfileContract({
    clock,
    fetch: async () =>
      json({
        kind: "youtube#channelListResponse",
        items: found ? [{ kind: "youtube#channel", id: "UC_fixture" }] : [],
      }),
  }).check(handleTarget, signal());
beforeEach(noNetwork);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("server-only compatibility projections", () => {
  it("projects_only_fresh_exact_domain_observations", async () => {
    const result = await registrar();
    expect(toDomainCheck(result, domainTarget, NOW)).toMatchObject({
      domain,
      provider: "cloudflare_registrar",
      availability: "available",
    });
    expect(toDomainCheck(result, domainTarget, NOW + 60_000)).toBeNull();
    expect(toDomainCheck(result, { ...domainTarget, domain: "other.test" }, NOW)).toBeNull();
    expect(toDomainCheck(result, domainTarget, NOW - 1)).toBeNull();
    expect(toDomainCheck(result, domainTarget, NaN)).toBeNull();
    expect(toDomainCheck(await registrar(false), domainTarget, NOW)?.availability).toBe("unknown");
    if (result.status !== "observed") throw new Error("Expected synthetic result");
    for (const changed of [
      { ...result, value: { ...result.value, availability: "available" } },
      ...[
        { providerId: "wrong" },
        { adapterVersion: "wrong" },
        { sourceUrl: "https://wrong.test/docs" },
        { rightsBasis: "licensed_api" },
        { freshUntil: new Date(NOW + 120_000).toISOString() },
      ].map((patch) => ({ ...result, provenance: { ...result.provenance, ...patch } })),
    ])
      expect(toDomainCheck(changed as ProviderResult<RegistrarObservation>, domainTarget, NOW)).toBeNull();
    expect(toDomainCheck(result, domainTarget, NOW)?.id).toBe(result.provenance.sourceReference);
  });
  it("declines_valid_submillisecond_evidence_the_legacy_check_cannot_represent", async () => {
    const result = structuredClone(await registrar());
    if (result.status !== "observed") throw new Error("Expected synthetic result");
    result.provenance.checkedAt = "2026-10-06T12:00:00.000000Z";
    result.provenance.observedAt = "2026-10-06T12:00:00.000000Z";
    result.provenance.freshUntil = "2026-10-06T12:00:00.000001Z";
    expect(providerResultSchema(registrarObservationSchema).safeParse(result).success).toBe(true);
    expect(toDomainCheck(result, domainTarget, NOW)).toBeNull();
  });
  it("profile_projection_never_confirms_availability", async () => {
    const found = await social(),
      empty = await social(false);
    expect(toHandleEvidence(found, handleTarget, NOW)).toMatchObject({
      outcome: "unknown",
      checkedAt: new Date(NOW).toISOString(),
    });
    expect(toHandleEvidence(empty, handleTarget, NOW).outcome).toBe("profile_missing");
    for (const evidence of [
      toHandleEvidence(found, handleTarget, NOW + 3_600_000),
      toHandleEvidence(found, { ...handleTarget, handle: "other" }, NOW),
      toHandleEvidence(
        {
          status: "failed",
          target: handleTarget,
          code: "not_authorized",
          retryAfterSeconds: null,
          observedAt: new Date(NOW).toISOString(),
        },
        handleTarget,
        NOW,
      ),
    ]) {
      expect(evidence).toMatchObject({ outcome: "unknown", checkedAt: null, authority: "none", source: null });
      expect(evidenceSchema.safeParse(evidence).success).toBe(true);
    }
    const forged = {
      ...found,
      value: {
        profile: "not_found",
        profileId: null,
        availability: "available",
        reservation: "unverified",
        ownership: "unverified",
      },
    } as unknown as ProviderResult<SocialProfileObservation>;
    expect(toHandleEvidence(forged, handleTarget, NOW).outcome).toBe("unknown");
  });

  it("constructors_have_no_ambient_runtime_effect", () => {
    const fetch = vi.fn(async () => json({}));
    createRegistrarCheckContract({ accountId, fetch, clock });
    createSocialProfileContract({ fetch, clock });
    createTrademarkSearchContract(null, clock);
    expect(fetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
