import { describe, expect, it } from "vitest";
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = id(1),
  at = "2026-10-06T12:00:00Z",
  hash = "a".repeat(64);
import { z } from "zod";
import {
  providerTargetSchema,
  providerProvenanceSchema,
  providerResultSchema,
  evidenceFreshnessAt,
} from "../../src/domain/standalone-provider-evidence";
const provenance = () => ({
  providerId: "official",
  adapterVersion: "1",
  contractVersion: 1,
  sourceUrl: "https://example.com/api",
  sourceReference: hash,
  providerRequestId: null,
  checkedAt: "2026-10-06T11:59:00Z",
  observedAt: at,
  freshUntil: "2026-10-06T13:00:00Z",
  rightsBasis: "official_api" as const,
});
describe("standalone provider evidence", () => {
  it("reuses canonical domain and platform/handle bounds", () => {
    expect(providerTargetSchema.safeParse({ tool: "domains", domain: "example.com" }).success).toBe(true);
    for (const domain of ["EXAMPLE.COM", "https://example.com", "bad domain"])
      expect(providerTargetSchema.safeParse({ tool: "domains", domain }).success).toBe(false);
    expect(
      providerTargetSchema.safeParse({ tool: "handles", platform: "instagram", handle: "example_1" }).success,
    ).toBe(true);
    expect(providerTargetSchema.safeParse({ tool: "handles", platform: "unknown", handle: "abc" }).success).toBe(false);
    expect(
      providerTargetSchema.safeParse({
        tool: "trademarks",
        mark: "Café",
        jurisdictions: ["US"],
        niceClasses: [1, 45],
        mode: "exact_word",
      }).success,
    ).toBe(true);
    expect(
      providerTargetSchema.safeParse({
        tool: "trademarks",
        mark: "X",
        jurisdictions: ["US", "US"],
        niceClasses: [],
        mode: "exact_word",
      }).success,
    ).toBe(false);
  });
  it("requires credential-free HTTPS sources and valid ordered times", () => {
    for (const sourceUrl of [
      "http://example.com",
      "https://u:p@example.com",
      "https://example.com?q=x",
      "https://example.com#x",
    ])
      expect(providerProvenanceSchema.safeParse({ ...provenance(), sourceUrl }).success).toBe(false);
    for (const patch of [
      { observedAt: "yesterday" },
      { checkedAt: "2026-10-06T14:00:00Z" },
      { freshUntil: at },
      { sourceReference: "A".repeat(64) },
    ])
      expect(providerProvenanceSchema.safeParse({ ...provenance(), ...patch }).success).toBe(false);
  });
  it("computes fresh, expiry equality stale, and uncertainty honestly", () => {
    const p = providerProvenanceSchema.parse(provenance());
    expect(evidenceFreshnessAt(p, Date.parse(at))).toBe("fresh");
    expect(evidenceFreshnessAt(p, Date.parse(p.freshUntil!))).toBe("stale");
    for (const now of [NaN, Infinity, Date.parse(at) - 1]) expect(evidenceFreshnessAt(p, now)).toBe("unknown");
    expect(evidenceFreshnessAt({ ...p, checkedAt: null }, Date.parse(at))).toBe("unknown");
    expect(evidenceFreshnessAt({ ...p, freshUntil: null }, Date.parse(at))).toBe("unknown");
  });
  it("validates generic observed values and disjoint failure envelopes", () => {
    const schema = providerResultSchema(z.strictObject({ available: z.boolean() }));
    const r = {
      status: "observed",
      target: { tool: "domains", domain: "example.com" },
      provenance: provenance(),
      value: { available: true },
    };
    expect(schema.safeParse(r).success).toBe(true);
    expect(schema.safeParse({ ...r, value: { available: true, clearance: true } }).success).toBe(false);
    expect(
      schema.safeParse({ status: "failed", target: r.target, code: "timeout", retryAfterSeconds: null, observedAt: at })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ ...r, status: "failed", code: "timeout" }).success).toBe(false);
  });
});

describe("provider adversarial boundary pairs", () => {
  it("validates exact microsecond timestamp chronology", () => {
    expect(
      providerProvenanceSchema.safeParse({
        ...provenance(),
        checkedAt: "2026-10-06T12:00:00.000002Z",
        observedAt: "2026-10-06T12:00:00.000001Z",
        freshUntil: "2026-10-06T12:00:00.000003Z",
      }).success,
    ).toBe(false);
    expect(
      providerProvenanceSchema.safeParse({
        ...provenance(),
        checkedAt: "2026-10-06T12:00:00.000001Z",
        observedAt: "2026-10-06T12:00:00.000002Z",
        freshUntil: "2026-10-06T12:00:00.000003Z",
      }).success,
    ).toBe(true);
  });
  it("does not accept unknown ownership fields in observed evidence", () => {
    expect(providerProvenanceSchema.safeParse({ ...provenance(), ownerId }).success).toBe(false);
    expect(providerProvenanceSchema.safeParse({ ...provenance(), sourceUrl: "https://example.com?" }).success).toBe(
      false,
    );
  });
});

// P6 consumer-shaped fixtures. Page bytes are compact decoded UTF-8 JSON;
// they are deliberately distinct from PostgreSQL JSONB textual spacing.
const compactBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const pagePayloadLimit = 262_144,
  providerEnvelopeAllowance = 16_384;
const researchPayloadLimit = 5 * (2 * pagePayloadLimit + providerEnvelopeAllowance) + providerEnvelopeAllowance;
const providerResultLimit = researchPayloadLimit + providerEnvelopeAllowance;
const trademarkTarget = {
  tool: "trademarks" as const,
  mark: "A",
  jurisdictions: ["US"],
  niceClasses: [],
  mode: "exact_word" as const,
};
const hitShape = z.strictObject({
  registryId: z.string().min(1).max(200),
  jurisdiction: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[A-Z0-9-]+$/),
  mark: z.string().min(1).max(160),
  recordUrl: z
    .string()
    .max(2048)
    .refine((v) => {
      const u = new URL(v);
      return (
        u.protocol === "https:" && u.host === "registry.example" && !u.username && !u.password && !u.search && !u.hash
      );
    }),
  niceClasses: z.array(z.number().int().min(1).max(45)).max(45),
  statusText: z.string().min(1).max(200),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
const trademarkPageSchema = z
  .strictObject({
    target: providerTargetSchema,
    jurisdictions: z.array(z.string().min(2).max(32)).max(20),
    datasetAsOf: z.iso.datetime({ offset: true }).nullable(),
    hits: z.array(hitShape).max(100),
    nextCursor: z.string().max(500).nullable(),
    complete: z.boolean(),
  })
  .refine((v) => compactBytes(v) <= pagePayloadLimit, "P6 page payload exceeds compact UTF-8 bound");
const trademarkResearchSchema = z
  .strictObject({
    query: providerTargetSchema,
    coverage: z.strictObject({
      requested: z.array(z.string()).max(20),
      searched: z.array(z.string()).max(20),
      missing: z.array(z.string()).max(20),
      niceEdition: z.string().min(1).max(64),
    }),
    pages: z.array(providerResultSchema(trademarkPageSchema)).max(5),
    hits: z.array(hitShape).max(500),
    completeness: z.enum(["complete", "partial"]),
    legalClearance: z.literal("not_assessed"),
    filing: z.literal("not_submitted"),
  })
  .refine((v) => compactBytes(v) <= researchPayloadLimit, "P6 retained research exceeds compact UTF-8 bound");
function trademarkPage(index = 0, exactBytes?: number) {
  const page = {
    target: trademarkTarget,
    jurisdictions: ["US"],
    datasetAsOf: at,
    hits: Array.from({ length: 100 }, (_, i) => ({
      registryId: `page${index}-id${i}`.padEnd(200, "r"),
      jurisdiction: "US",
      mark: "A".repeat(160),
      recordUrl: `https://registry.example/records/${index}/${i}`,
      niceClasses: [],
      statusText: "s".repeat(200),
      updatedAt: null,
    })),
    nextCursor: null,
    complete: true,
  };
  if (exactBytes !== undefined) {
    let remaining = exactBytes - compactBytes(page);
    for (const hit of page.hits) {
      const count = Math.min(2048 - hit.recordUrl.length, remaining);
      hit.recordUrl += "x".repeat(count);
      remaining -= count;
    }
    if (remaining !== 0) throw new Error("Fixture cannot reach its requested byte length");
  }
  return page;
}
const observedPage = (value: ReturnType<typeof trademarkPage>) => ({
  status: "observed" as const,
  target: trademarkTarget,
  provenance: provenance(),
  value,
});
describe("F1: P6 response/page/aggregate composition", () => {
  it("admits a consumer-valid 100-hit page above the logo mutation ceiling", () => {
    const page = trademarkPage();
    expect(compactBytes(page)).toBeGreaterThan(32768);
    expect(trademarkPageSchema.safeParse(page).success).toBe(true);
    const result = providerResultSchema(trademarkPageSchema).safeParse(observedPage(page));
    expect(result.success).toBe(true);
    if (result.success && result.data.status === "observed") expect(result.data.value.hits).toHaveLength(100);
  });
  it("preserves the full 262144-byte page allowance plus its result envelope", () => {
    const page = trademarkPage(0, pagePayloadLimit);
    expect(compactBytes(page)).toBe(pagePayloadLimit);
    expect(compactBytes(observedPage(page))).toBeGreaterThan(pagePayloadLimit);
    expect(providerResultSchema(trademarkPageSchema).safeParse(observedPage(page)).success).toBe(true);
    expect(
      providerResultSchema(trademarkPageSchema).safeParse(observedPage(trademarkPage(0, pagePayloadLimit + 1))).success,
    ).toBe(false);
  });
  it("retains all five near-limit pages and all 500 duplicated aggregate hits", () => {
    const pages = Array.from({ length: 5 }, (_, i) => observedPage(trademarkPage(i, pagePayloadLimit)));
    const value = {
      query: trademarkTarget,
      coverage: { requested: ["US"], searched: ["US"], missing: [], niceEdition: "12" },
      pages,
      hits: pages.flatMap((p) => p.value.hits),
      completeness: "complete",
      legalClearance: "not_assessed",
      filing: "not_submitted",
    };
    const result = providerResultSchema(trademarkResearchSchema).safeParse({
      status: "observed",
      target: trademarkTarget,
      provenance: provenance(),
      value,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.status === "observed") {
      expect(result.data.value.pages).toHaveLength(5);
      expect(result.data.value.hits).toEqual(value.hits);
      expect(result.data.value.hits).toHaveLength(500);
    }
  });
  it("keeps a finite aggregate result byte ceiling with an exact limit/+1 pair", () => {
    const schema = providerResultSchema(z.strictObject({ text: z.string().max(providerResultLimit) }));
    const raw = { status: "observed", target: trademarkTarget, provenance: provenance(), value: { text: "" } };
    raw.value.text = "x".repeat(providerResultLimit - compactBytes(raw));
    expect(compactBytes(raw)).toBe(providerResultLimit);
    expect(schema.safeParse(raw).success).toBe(true);
    expect(schema.safeParse({ ...raw, value: { text: raw.value.text + "x" } }).success).toBe(false);
  });
  it("preserves feature cardinality, field validation and strict envelope keys", () => {
    const page = trademarkPage();
    const schema = providerResultSchema(trademarkPageSchema);
    expect(schema.safeParse(observedPage({ ...page, hits: [...page.hits, page.hits[0]!] })).success).toBe(false);
    expect(
      schema.safeParse(
        observedPage({ ...page, hits: [{ ...page.hits[0]!, recordUrl: "https://evil.example/record" }] }),
      ).success,
    ).toBe(false);
    expect(schema.safeParse({ ...observedPage(page), ownerId }).success).toBe(false);
  });
  it("also bounds pathological JSONB numeric expansion", () => {
    const schema = providerResultSchema(z.strictObject({ numbers: z.array(z.number()).max(20000) }));
    const raw = {
      status: "observed",
      target: trademarkTarget,
      provenance: provenance(),
      value: { numbers: Array(20000).fill(1e308) },
    };
    expect(compactBytes(raw)).toBeLessThan(providerResultLimit);
    expect(schema.safeParse(raw).success).toBe(false);
  });
});
