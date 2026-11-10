import { describe, expect, it } from "vitest";
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = id(1),
  projectId = id(2),
  at = "2026-10-06T12:00:00Z",
  hash = "a".repeat(64);
const asset = (n = 10) => ({ ownerId, projectId, assetId: id(n), versionId: id(n + 1), contentHash: hash });
import {
  logoVectorDocumentSchema,
  logoManualEditSchema,
  logoVectorRevisionSchema,
  logoVectorProofSchema,
  logoTextSourceSchema,
  logoComponentLockSchema,
  logoTraceSettingsSchema,
} from "../../src/domain/logo-vector";
const path = () => ({
  id: "path-1",
  d: "M 0 0 L 10 0 L 10 10 Z",
  fill: { color: "#000000", opacity: 1 },
  stroke: null,
  fillRule: "nonzero",
});
const document = () => ({
  version: 1,
  viewBox: [0, 0, 100, 100],
  components: [
    {
      id: "symbol",
      role: "symbol",
      editingKind: "geometry",
      paths: [path()],
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    },
  ],
});
const proof = () => ({
  version: 1,
  svgContentHash: hash,
  documentHash: hash,
  validator: { id: "p3", version: "1" },
  viewBox: [0, 0, 100, 100],
  pathCount: 1,
  componentCount: 1,
  externalFontDependencies: [],
});
describe("passive vector contract", () => {
  it("accepts canonical geometry and rejects raster wrappers and unsupported paints", () => {
    expect(logoVectorDocumentSchema.safeParse(document()).success).toBe(true);
    for (const patch of [{ image: "data:image/png;base64,abc" }, { opacity: 0.5 }, { filter: "blur(1px)" }])
      expect(
        logoVectorDocumentSchema.safeParse({ ...document(), components: [{ ...document().components[0], ...patch }] })
          .success,
      ).toBe(false);
    for (const d of [
      "m 0 0 l 10 10",
      "M 0 0 A 1 1 0 0 1 2 2",
      "M 0 0 L NaN 2",
      "M 0 0 L 1",
      "M 1000001 0 L 0 0",
      "M 0 0<script>",
    ])
      expect(
        logoVectorDocumentSchema.safeParse({
          ...document(),
          components: [{ ...document().components[0], paths: [{ ...path(), d }] }],
        }).success,
      ).toBe(false);
  });
  it("enforces finite dimensions, coordinate and transform ceilings", () => {
    for (const viewBox of [
      [0, 0, 0, 100],
      [0, 0, 16385, 100],
      [Infinity, 0, 100, 100],
    ])
      expect(logoVectorDocumentSchema.safeParse({ ...document(), viewBox }).success).toBe(false);
    expect(logoVectorDocumentSchema.safeParse({ ...document(), viewBox: [-1000000, 0, 16384, 100] }).success).toBe(
      true,
    );
    for (const scale of [0, 100.01, Infinity])
      expect(logoManualEditSchema.safeParse({ kind: "size", componentId: "symbol", scale }).success).toBe(false);
    expect(logoManualEditSchema.safeParse({ kind: "size", componentId: "symbol", scale: 100 }).success).toBe(true);
  });
  it("bounds paths and rejects duplicate identifiers", () => {
    const c = document().components[0]!;
    expect(logoVectorDocumentSchema.safeParse({ ...document(), components: [c, c] }).success).toBe(false);
    expect(
      logoVectorDocumentSchema.safeParse({
        ...document(),
        components: [{ ...c, paths: Array.from({ length: 20001 }, (_, i) => ({ ...path(), id: `p${i}` })) }],
      }).success,
    ).toBe(false);
  });
  it("pins paint alpha and stroke shape", () => {
    const p = {
      ...path(),
      stroke: { color: "#FF0000", width: 10000, opacity: 0.5, linecap: "round", linejoin: "bevel", miterLimit: 100 },
    };
    const withPath = (p: unknown) => ({ ...document(), components: [{ ...document().components[0], paths: [p] }] });
    expect(logoVectorDocumentSchema.safeParse(withPath(p)).success).toBe(true);
    expect(logoVectorDocumentSchema.safeParse(withPath({ ...p, stroke: { ...p.stroke, width: 10001 } })).success).toBe(
      false,
    );
    expect(
      logoVectorDocumentSchema.safeParse(withPath({ ...p, fill: { color: "url(#remote)", opacity: 1 } })).success,
    ).toBe(false);
  });
  it("pins editable text metadata without giving outlined lettering font controls", () => {
    const source = {
      text: "Café",
      contentKind: "brand_name",
      font: asset(),
      rightsEvidenceId: id(3),
      faceIndex: 0,
      size: 24,
      variationAxes: { wght: 400 },
      featureTags: { liga: true },
      language: "fr",
      script: "Latn",
      direction: "ltr",
      letterSpacing: 0,
      lineHeight: 1.2,
      shapingEngine: { id: "harfbuzz", version: "1" },
    };
    expect(logoTextSourceSchema.safeParse(source).success).toBe(true);
    expect(logoTextSourceSchema.safeParse({ ...source, text: "😀".repeat(201) }).success).toBe(false);
    expect(
      logoVectorDocumentSchema.safeParse({
        ...document(),
        components: [{ ...document().components[0], textSource: source }],
      }).success,
    ).toBe(false);
    expect(
      logoVectorDocumentSchema.safeParse({
        ...document(),
        components: [{ ...document().components[0], editingKind: "editable_text", textSource: source }],
      }).success,
    ).toBe(true);
  });
  it("keeps restored candidates review_required and approval separate", () => {
    const r = {
      id: id(3),
      ownerId,
      projectId,
      parentRevisionId: id(4),
      source: { kind: "refinement", rasterRevisionId: id(5) },
      sourcePreview: asset(),
      documentAsset: asset(30),
      svgAsset: asset(40),
      documentHash: hash,
      proof: proof(),
      locks: [],
      inputRevisions: [],
      reviewStatus: "review_required",
      createdAt: at,
    };
    expect(logoVectorRevisionSchema.safeParse(r).success).toBe(true);
    expect(logoVectorRevisionSchema.safeParse({ ...r, reviewStatus: "approved" }).success).toBe(false);
    expect(logoVectorRevisionSchema.safeParse({ ...r, sourcePreview: { ...asset(), ownerId: id(99) } }).success).toBe(
      false,
    );
    expect(logoVectorProofSchema.safeParse({ ...proof(), externalFontDependencies: [id(9)] }).success).toBe(false);
  });
  it("requires complete lock digests and strict manual alternatives", () => {
    const lock = {
      componentId: "symbol",
      geometryHash: hash,
      appearanceHash: hash,
      transformHash: hash,
      textHash: hash,
      zOrderHash: hash,
      effectiveHash: hash,
    };
    expect(logoComponentLockSchema.safeParse(lock).success).toBe(true);
    expect(logoComponentLockSchema.safeParse({ ...lock, textHash: "" }).success).toBe(false);
    expect(logoManualEditSchema.safeParse({ kind: "locks", componentIds: ["symbol", "symbol"] }).success).toBe(false);
    expect(
      logoManualEditSchema.safeParse({ kind: "text", componentId: "symbol", text: "Café", rightsEvidenceId: id(3) })
        .success,
    ).toBe(false);
  });
  it("bounds trace settings", () => {
    expect(
      logoTraceSettingsSchema.safeParse({ preset: "poster", simplify: 2.5, filterSpeckle: 16, maxColors: 32 }).success,
    ).toBe(true);
    expect(
      logoTraceSettingsSchema.safeParse({ preset: "bw", simplify: 0, filterSpeckle: 0, maxColors: 32 }).success,
    ).toBe(false);
  });
});

describe("vector parser limit pairs", () => {
  it("accepts 20000 paths and rejects aggregate paths above the ceiling", () => {
    const c = document().components[0]!;
    const paths = Array.from({ length: 20000 }, (_, i) => ({ ...path(), id: `p${i}` }));
    expect(logoVectorDocumentSchema.safeParse({ ...document(), components: [{ ...c, paths }] }).success).toBe(true);
    expect(
      logoVectorDocumentSchema.safeParse({
        ...document(),
        components: [
          { ...c, paths },
          { ...c, id: "extra", paths: [{ ...path(), id: "extra-path" }] },
        ],
      }).success,
    ).toBe(false);
  });
  it("accepts 200000 commands and rejects the next command", () => {
    const c = document().components[0]!;
    const d = "M 0 0 " + "L 1 1 ".repeat(199999);
    expect(
      logoVectorDocumentSchema.safeParse({ ...document(), components: [{ ...c, paths: [{ ...path(), d }] }] }).success,
    ).toBe(true);
    expect(
      logoVectorDocumentSchema.safeParse({ ...document(), components: [{ ...c, paths: [{ ...path(), d: d + "Z" }] }] })
        .success,
    ).toBe(false);
  });
  it("accepts 64 components and rejects 65", () => {
    const c = document().components[0]!;
    const components = Array.from({ length: 64 }, (_, i) => ({
      ...c,
      id: `c${i}`,
      paths: [{ ...path(), id: `p${i}` }],
    }));
    expect(logoVectorDocumentSchema.safeParse({ ...document(), components }).success).toBe(true);
    expect(
      logoVectorDocumentSchema.safeParse({
        ...document(),
        components: [...components, { ...c, id: "extra", paths: [{ ...path(), id: "extra-path" }] }],
      }).success,
    ).toBe(false);
  });
  it("distinguishes supported manual controls without path editing or trust assertions", () => {
    for (const edit of [
      { kind: "font", componentId: "symbol", fontVersionId: id(3) },
      { kind: "spacing", componentId: "symbol", letterSpacing: 0, lineHeight: 1.2 },
      { kind: "rotation", componentId: "symbol", degrees: -180 },
      { kind: "color", componentId: "symbol", fill: "#FF0000", stroke: null },
      {
        kind: "arrangement",
        placements: [{ componentId: "symbol", transform: { x: 1, y: 2, scale: 1, rotation: 0 } }],
        order: ["symbol"],
      },
      { kind: "group_components", regions: [{ id: "symbol", role: "symbol", bounds: [0, 0, 100, 100] }] },
      { kind: "replace_outlined_lettering", componentId: "symbol", fontVersionId: id(3), text: "Café" },
    ])
      expect(logoManualEditSchema.safeParse(edit).success).toBe(true);
    expect(logoManualEditSchema.safeParse({ kind: "path", componentId: "symbol", d: path().d }).success).toBe(false);
  });
});

function maximumLockRevision() {
  const componentIds = Array.from({ length: 64 }, (_, i) => `component-${i}`.padEnd(200, "x"));
  return {
    id: id(3),
    ownerId,
    projectId,
    parentRevisionId: id(4),
    source: { kind: "concept", batchId: id(5), slotId: id(6), attemptId: id(7) },
    sourcePreview: asset(),
    documentAsset: asset(30),
    svgAsset: asset(40),
    documentHash: hash,
    proof: {
      ...proof(),
      validator: { id: "v".repeat(200), version: "v".repeat(200) },
      viewBox: [-Number.MIN_VALUE, -Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE],
      pathCount: 20000,
      componentCount: 64,
    },
    locks: componentIds.map((componentId) => ({
      componentId,
      geometryHash: hash,
      appearanceHash: hash,
      transformHash: hash,
      textHash: hash,
      zOrderHash: hash,
      effectiveHash: hash,
    })),
    inputRevisions: Array.from({ length: 100 }, (_, i) => ({
      stage: "brief_references",
      id: id(1000 + i),
      revision: Number.MAX_SAFE_INTEGER,
    })),
    reviewStatus: "review_required",
    createdAt: "2026-10-06T12:00:00." + "1".repeat(43) + "Z",
  };
}
describe("F3: complete lock records are distinct from mutation commands", () => {
  it("represents 64 full six-digest locks in the maximum scalar-field vector revision", () => {
    const r = maximumLockRevision();
    expect(
      logoManualEditSchema.safeParse({ kind: "locks", componentIds: r.locks.map((l) => l.componentId) }).success,
    ).toBe(true);
    const parsed = logoVectorRevisionSchema.safeParse(r);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.locks).toHaveLength(64);
      expect(parsed.data.locks).toEqual(r.locks);
    }
  });
  it("rejects the 65th lock and malformed or contradictory hashes", () => {
    const r = maximumLockRevision();
    expect(
      logoVectorRevisionSchema.safeParse({ ...r, locks: [...r.locks, { ...r.locks[0]!, componentId: "extra" }] })
        .success,
    ).toBe(false);
    expect(
      logoVectorRevisionSchema.safeParse({
        ...r,
        locks: r.locks.map((l, i) => (i ? l : { ...l, effectiveHash: "z".repeat(64) })),
      }).success,
    ).toBe(false);
    expect(
      logoVectorRevisionSchema.safeParse({ ...r, proof: { ...r.proof, documentHash: "b".repeat(64) } }).success,
    ).toBe(false);
  });
});
describe("F4: canonical path separators", () => {
  it.each([
    ",M 0 0 L 1 1",
    "M 0 0 L 1 1,",
    "M ,0 0 L 1 1",
    "M 0,,0 L 1 1",
    "M 0, ,0 L 1 1",
    "M 0 0,L 1 1",
    "M 0 0 L,1 1",
    "M 0 0 L 1,1,Z",
    "M 0 0 Z,",
    "M 0 0,Z",
    "M 0 0 Q,1 1 2 2",
    "M 0 0 Q 1,,1 2 2",
    "M 0 0 Q 1 1 2 2, Z",
    "M 0 0 C,1 1 2 2 3 3",
    "M 0 0 C 1 1 2 2 3,,3",
    "M 0 0 C 1 1 2 2 3 3,",
    "M 0 0 Z,M 1 1",
  ])("rejects misplaced commas without rewriting %s", (d) => {
    expect(
      logoVectorDocumentSchema.safeParse({
        ...document(),
        components: [{ ...document().components[0], paths: [{ ...path(), d }] }],
      }).success,
    ).toBe(false);
  });
  it.each([
    "M0,0L1,1Z",
    " M 0, 0\tL 1 , 1\nZ ",
    "M.1-.2L+1e2,-2E-2Z",
    "M0 0Q1,1,2,2C2 2,3 3,4 4Z",
    "M0 0 L1 1 Z M2 2 L3 3 Z",
  ])("retains valid supported numeric and separator syntax %s", (d) => {
    const parsed = logoVectorDocumentSchema.parse({
      ...document(),
      components: [{ ...document().components[0], paths: [{ ...path(), d }] }],
    });
    expect(parsed.components[0]!.paths[0]!.d).toBe(d);
  });
});
