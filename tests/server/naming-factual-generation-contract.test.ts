import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingStageRequestSchema, validateNamingCreatorSet } from "../../src/domain/naming-brain";
import { buildNamingManagedRequest, createNamingRoleRequest, namingOutputSchemaForRequest, namingRequestHash } from "../../src/server/ai/naming-brain/prompts";
import { validateNamingRoleOutput } from "../../src/server/ai/naming-brain/outputs";
import { creatorContractFixture } from "../fixtures/naming-creator-contract";
import { directorFixture } from "../fixtures/naming-director-allocation";

describe("future factual Naming contract4 (synthetic retained shapes)", () => {
  it("reproduces the claim-free factual proposal hole without rewriting historical artifacts or request hashes", () => {
    const prior = creatorContractFixture(3), raw = structuredClone(prior.output);
    raw.candidates.forEach(candidate => { candidate.claims = []; });
    const before = JSON.stringify(raw);
    expect(namingOutputSchemaForRequest(prior.request).safeParse(raw).success).toBe(true);
    const retained = validateNamingRoleOutput(prior.options(raw));
    if (prior.request.input.role !== "creator" || retained.output.role !== "creator") throw Error("Invalid synthetic Creator fixture");
    const checked = validateNamingCreatorSet(prior.request.input.snapshot, prior.request.input.assignment, retained);
    expect(checked.accepted).toHaveLength(0); expect(checked.rejected).toHaveLength(6);
    expect(checked.rejected.every(candidate => candidate.reason === "unsupported_primary_claim")).toBe(true);
    expect(JSON.stringify(raw)).toBe(before);
    expect(prior.request.requestHash).toBe("1b24ddba530597dc329e7a0a76f42a7d723be3fa338730770a5c067fcbcb5c2f");
    expect(namingRequestHash(prior.request)).toBe(prior.request.requestHash);
    expect(creatorContractFixture(2).request.requestHash).toBe("78abc383e2929afe3c75999f5b239f58a454e2df7c0328eeaabbbdb95b74248a");
    expect(creatorContractFixture(4).request.requestHash).toBe("8869f96378e60ed966cfa00e3891a36591e50f2c1ee9f20f413edeaef101965d");
    expect(directorFixture(true).request.requestHash).toBe("961f714ac600c9aa191007720edd747eff34e72fe1d2ddfc197b678f3179ef73");
  });

  it("requires real source-bound primary claims in the provider's ordinary structured-output schema", () => {
    const fixture = creatorContractFixture(4), wire = buildNamingManagedRequest(fixture.request), format = wire.agent!.text!.format;
    if (format?.type !== "json_schema") throw Error("Missing schema");
    expect(format.schema).toMatchObject({ properties: { candidates: { items: { properties: { claims: {
      minItems: 1, maxItems: 8, items: { properties: { requirement: { const: "primary_approach" }, sourceKeys: { minItems: 1, items: { enum: ["source-one"] } } } },
    } } } } } });
    expect(JSON.stringify(format.schema)).not.toContain("prefixItems"); expect(JSON.stringify(format.schema)).not.toContain("minContains");
    expect(wire.agent!.instructions).toContain("Omit unrelated optional factual asides instead of relabeling");
    expect(wire.metadata?.embel_progressive_contract_version).toBe("4"); expect(wire).not.toHaveProperty("spend_control");
    expect(wire.metadata).not.toHaveProperty("embel_provider_spend_cap_cents");
    expect(namingStageRequestSchema.parse(fixture.request)).toEqual(fixture.request);
    const raw = JSON.stringify(fixture.output), output = validateNamingRoleOutput(fixture.options());
    expect(output.output).toEqual(fixture.output); expect(JSON.stringify(fixture.output)).toBe(raw);
    expect(fixture.output.candidates.every(candidate => candidate.claims.every(claim => claim.status === "unverified"))).toBe(true);
  });

  it("asks a new Director to bind retrieved factual sources without forcing fabricated support", () => {
    const prior = directorFixture(true).request;
    const request = createNamingRoleRequest({ ...prior, policy: { ...prior.policy, progressiveContractVersion: 4 } });
    const wire = buildNamingManagedRequest(request);
    expect(wire.agent!.instructions).toContain("Bind those keys explicitly");
    expect(wire.agent!.instructions).toContain("keep that direction conditional and sourceKeys empty");
    expect(wire.agent!.instructions).toContain("Do not attach an unrelated source");
    expect(request.input).toEqual(prior.input);
    expect(wire.metadata?.embel_progressive_contract_version).toBe("4");
  });

  it.each(["other_languages", "classical_roots", "people_places", "stories_culture"] as const)("does not let %s omit its primary attribution", approach => {
    const fixture = creatorContractFixture(4), request = structuredClone(fixture.request), raw = structuredClone(fixture.output);
    if (request.input.role !== "creator") throw Error("Invalid synthetic fixture");
    request.input.assignment.primaryApproach = approach;
    raw.candidates.forEach(candidate => { candidate.primaryApproach = approach; candidate.claims = []; });
    expect(namingOutputSchemaForRequest(request).safeParse(raw).success).toBe(false);
  });

  it.each(["missing", "optional-only", "empty-sources", "foreign-source", "self-certified"] as const)("rejects %s factual output without synthesizing a claim or source", defect => {
    const fixture = creatorContractFixture(4), raw = structuredClone(fixture.output);
    if (defect === "missing") raw.candidates[0]!.claims = [];
    if (defect === "optional-only") raw.candidates[0]!.claims[0]!.requirement = "optional";
    if (defect === "empty-sources") raw.candidates[0]!.claims[0]!.sourceKeys = [];
    if (defect === "foreign-source") raw.candidates[0]!.claims[0]!.sourceKeys = ["fabricated-source"];
    if (defect === "self-certified") (raw.candidates[0]!.claims[0] as { status: string }).status = "supported";
    const before = JSON.stringify(raw);
    expect(namingOutputSchemaForRequest(fixture.request).safeParse(raw).success).toBe(false);
    expect(() => validateNamingRoleOutput(fixture.options(raw))).toThrow(); expect(JSON.stringify(raw)).toBe(before);
  });

  it("fails before a factual Creator request can be rendered without actual retrieved assignment sources", () => {
    const fixture = creatorContractFixture(4), request = structuredClone(fixture.request);
    if (request.input.role !== "creator") throw Error("Invalid synthetic fixture");
    request.input.assignment.sources = request.input.assignment.sources.map(source => ({ ...source, evidenceStatus: "unretrieved", excerpt: null, contentHash: null, retrieval: null }));
    expect(() => buildNamingManagedRequest(request)).toThrow("factual_creator_sources_unavailable");
    request.input.assignment.sources = []; request.input.assignment.sourceKeys = [];
    expect(() => buildNamingManagedRequest(request)).toThrow("factual_creator_sources_unavailable");
  });

  it("retains honest empty factual results and claim-free creative candidates", () => {
    const fixture = creatorContractFixture(4), empty = { ...fixture.output, candidates: [] };
    expect(namingOutputSchemaForRequest(fixture.request).safeParse(empty).success).toBe(true);
    const request = structuredClone(fixture.request), creative = structuredClone(fixture.output);
    if (request.input.role !== "creator") throw Error("Invalid synthetic fixture");
    request.input.assignment.primaryApproach = "real_words";
    creative.candidates.forEach(candidate => { candidate.primaryApproach = "real_words"; candidate.claims = []; });
    expect(namingOutputSchemaForRequest(request).safeParse(creative).success).toBe(true);
  });
});
