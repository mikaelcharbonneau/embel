import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingStageRequestSchema } from "../../src/domain/naming-brain";
import { buildNamingManagedRequest, namingOutputSchemaForRequest, namingRequestHash } from "../../src/server/ai/naming-brain/prompts";
import { validateNamingRoleOutput } from "../../src/server/ai/naming-brain/outputs";
import { creatorContractFixture } from "../fixtures/naming-creator-contract";
import { directorFixture } from "../fixtures/naming-director-allocation";

describe("future assignment-bound Creator output contract", () => {
  it("reproduces unassigned invented credit without changing historical request hashes", () => {
    const fixture = creatorContractFixture(2);
    const invalid = { ...fixture.output, candidates: fixture.output.candidates.map(candidate => ({ ...candidate, additionalApproaches: ["invented"] })) };
    expect(namingOutputSchemaForRequest(fixture.request).safeParse(invalid).success).toBe(true);
    expect(() => validateNamingRoleOutput(fixture.options(invalid))).toThrow("Candidate credit must come from its validated assignment");
    expect(fixture.request.requestHash).toBe("78abc383e2929afe3c75999f5b239f58a454e2df7c0328eeaabbbdb95b74248a");
    expect(namingRequestHash(fixture.request)).toBe(fixture.request.requestHash);
    expect(directorFixture(true).request.requestHash).toBe("961f714ac600c9aa191007720edd747eff34e72fe1d2ddfc197b678f3179ef73");
  });

  it("constrains provider identity, route credit, sources and count at generation time", () => {
    const { request } = creatorContractFixture(3), wire = buildNamingManagedRequest(request);
    const format = wire.agent!.text!.format;
    if (format?.type !== "json_schema") throw Error("Missing structured output");
    expect(format.schema).toMatchObject({ properties: {
      assignmentKey: { const: "roots" }, candidates: { maxItems: 60, items: { properties: {
        primaryApproach: { const: "classical_roots" }, additionalApproaches: { maxItems: 0 },
        territoryId: { const: "nature" }, constructionKey: { const: "original" },
        claims: { items: { properties: { sourceKeys: { items: { enum: ["source-one"] }, maxItems: 20 } } } },
      } } },
    } });
    expect(wire.metadata?.embel_progressive_contract_version).toBe("3");
    expect(namingStageRequestSchema.parse(request)).toEqual(request);
    expect(namingRequestHash(request)).toBe(request.requestHash);
  });

  it("accepts valid unusual names without rewriting raw JSON, source claims or receipts", () => {
    const fixture = creatorContractFixture(3), before = JSON.stringify(fixture.output);
    const result = validateNamingRoleOutput(fixture.options());
    expect(result.output).toEqual(fixture.output); expect(JSON.stringify(fixture.output)).toBe(before);
    expect(result.providerReceipt.requestHash).toBe(fixture.request.requestHash);
    expect(result.output.role === "creator" && result.output.candidates).toHaveLength(6);
  });

  it("permits only explicitly assigned secondary tags and retained sources", () => {
    const fixture = creatorContractFixture(3), request = structuredClone(fixture.request);
    if (request.input.role !== "creator") throw Error("Expected Creator fixture");
    request.input.assignment.additionalApproaches = ["real_words"];
    const output = structuredClone(fixture.output); output.candidates[0]!.additionalApproaches = ["real_words"];
    expect(namingOutputSchemaForRequest(request).safeParse(output).success).toBe(true);
    output.candidates[0]!.additionalApproaches = ["real_words", "real_words"];
    expect(namingOutputSchemaForRequest(request).safeParse(output).success).toBe(false);
    output.candidates[0]!.additionalApproaches = [];
    request.input.assignment.sources = []; request.input.assignment.sourceKeys = [];
    expect(namingOutputSchemaForRequest(request).safeParse(output).success).toBe(false);
    output.candidates.forEach(candidate => candidate.claims.forEach(claim => { claim.sourceKeys = []; }));
    expect(namingOutputSchemaForRequest(request).safeParse(output).success).toBe(true);
    // Schema validity is not factual verification or publication authority.
    expect(output.candidates.every(candidate => candidate.claims.every(claim => claim.status === "unverified"))).toBe(true);
  });

  it.each(["additional", "primary", "assignment", "territory", "construction", "source", "count", "duplicate-key"] as const)("refuses %s mismatch in the future output schema", defect => {
    const fixture = creatorContractFixture(3), value = structuredClone(fixture.output);
    const first = value.candidates[0]!;
    if (defect === "additional") first.additionalApproaches = ["invented"];
    if (defect === "primary") first.primaryApproach = "real_words";
    if (defect === "assignment") value.assignmentKey = "foreign";
    if (defect === "territory") first.territoryId = "foreign";
    if (defect === "construction") first.constructionKey = "foreign";
    if (defect === "source") first.claims[0]!.sourceKeys = ["unretained-source"];
    if (defect === "count") value.candidates = Array.from({ length: 61 }, (_, i) => ({ ...first, candidateKey: `candidate-${i}` }));
    if (defect === "duplicate-key") value.candidates[1]!.candidateKey = first.candidateKey;
    expect(namingOutputSchemaForRequest(fixture.request).safeParse(value).success).toBe(false);
    expect(() => validateNamingRoleOutput(fixture.options(value))).toThrow();
  });
});
