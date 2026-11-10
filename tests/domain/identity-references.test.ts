import { describe, expect, it } from "vitest";
import {
  applyReferenceReaction,
  createIdentityReferenceSnapshot,
  identityReferenceBasis,
  identityReferenceEntrySchema,
  identityReferenceQuerySchema,
  identityReferenceSchema,
  identityReferenceSnapshotSchema,
  identityReferencesOverviewSchema,
  referenceSourceResultSchema,
  setReferenceReactionSchema,
  setReferenceReactionResponseSchema,
  validateIdentityReferenceQuery,
} from "../../src/domain/identity-references";

// Synthetic metadata only; these tests do not assert that a file or source exists.
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = (n: number) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`;
const now = "2026-10-04T11:00:00Z";
function reference(index = 1) {
  return {
    id: id(index),
    ownerId,
    projectId,
    createdAt: now,
    media: {
      assetId: id(index + 100),
      versionId: id(index + 200),
      ownerId,
      projectId,
      contentHash: "a".repeat(64),
      purpose: "reference_media",
      mimeType: "image/png",
    },
    source: "user_supplied",
    attribution: {
      label: "Synthetic reference",
      creator: null,
      sourceUrl: "https://example.invalid/reference",
      rightsNote: null,
    },
    relevantElements: ["logo", "colors", "typography"],
    tags: ["synthetic-tag"],
  };
}
function entry(index = 1, ensemble = false, elements = ["logo", "colors"]) {
  return identityReferenceEntrySchema.parse({
    reference: reference(index),
    reaction: {
      referenceId: id(index),
      ownerId,
      projectId,
      revision: 1,
      ensemble,
      elements,
      updatedAt: now,
    },
  });
}
function snapshotInput(entries = [entry()]) {
  return {
    ownerId,
    projectId,
    referenceRevision: 1,
    selectedReferenceCount: entries.length,
    selected: entries,
    capturedAt: now,
  };
}
function transition(overrides: Record<string, unknown> = {}) {
  return {
    actorId: ownerId,
    projectId,
    reference: identityReferenceSchema.parse(reference()),
    current: null,
    input: { expectedRevision: 0, ensemble: false, elements: ["logo", "colors"] },
    now,
    ...overrides,
  };
}

describe("owned identity reference records", () => {
  it("binds an immutable media version without file readiness, URLs or generated-system claims", () => {
    const parsed = identityReferenceSchema.parse(reference());
    expect(parsed.media).toEqual(reference().media);
    expect(parsed.relevantElements).toEqual(["logo", "typography", "colors"]);
    expect(parsed).not.toHaveProperty("previewUrl");
    expect(parsed.media).not.toHaveProperty("fileState");
  });
  it.each([
    { ownerId: id(99) },
    { projectId: id(98) },
    { purpose: "brand_asset" },
    { purpose: "legacy_unknown" },
    { mimeType: "image/svg+xml" },
    { mimeType: "text/html" },
    { contentHash: "unknown" },
    { storagePath: "owner/private/file" },
    { url: "https://example.invalid/private" },
    { verified: true },
  ])("rejects unowned, non-reference or unsafe media metadata %j", (patch) => {
    const value = reference();
    Object.assign(value.media, patch);
    expect(identityReferenceSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    { relevantElements: ["logo", "logo"] },
    { relevantElements: ["unknown"] },
    { relevantElements: ["ensemble"] },
  ])("rejects unknown and duplicate relevant elements %j", ({ relevantElements }) => {
    expect(identityReferenceSchema.safeParse({ ...reference(), relevantElements }).success).toBe(false);
  });
  it("allows an Ensemble-only reference without inventing component relevance", () => {
    const parsed = identityReferenceSchema.parse({ ...reference(), relevantElements: [] });
    expect(parsed.relevantElements).toEqual([]);
  });
  it.each([
    "javascript:alert(1)",
    "data:image/png;base64,AA==",
    "file:///private/file",
    "https://user:secret@example.invalid/",
  ])("rejects unsafe attribution links %s", (sourceUrl) => {
    const value = reference();
    value.attribution.sourceUrl = sourceUrl;
    expect(identityReferenceSchema.safeParse(value).success).toBe(false);
  });
  it("allows attribution without a website and does not manufacture license verification", () => {
    const value = reference();
    expect(
      identityReferenceSchema.safeParse({ ...value, attribution: { ...value.attribution, sourceUrl: null } }).success,
    ).toBe(true);
    expect(
      identityReferenceSchema.safeParse({ ...value, attribution: { ...value.attribution, licenseVerified: true } })
        .success,
    ).toBe(false);
  });
});

describe("independent reference reactions and optimistic revisions", () => {
  it("retains two element likes independently and does not infer Ensemble", () => {
    const next = applyReferenceReaction(transition());
    expect(next).toEqual({
      referenceId: id(1),
      ownerId,
      projectId,
      revision: 1,
      ensemble: false,
      elements: ["logo", "colors"],
      updatedAt: now,
    });
    const changed = applyReferenceReaction(
      transition({ current: next, input: { expectedRevision: 1, ensemble: false, elements: ["colors"] } }),
    );
    expect(changed.elements).toEqual(["colors"]);
    expect(next.elements).toEqual(["logo", "colors"]);
    expect(changed.revision).toBe(2);
  });
  it("Ensemble alone creates no element likes, and turning it off preserves explicit elements", () => {
    const whole = applyReferenceReaction(transition({ input: { expectedRevision: 0, ensemble: true, elements: [] } }));
    expect(whole.ensemble).toBe(true);
    expect(whole.elements).toEqual([]);
    const both = applyReferenceReaction(
      transition({ current: whole, input: { expectedRevision: 1, ensemble: true, elements: ["colors"] } }),
    );
    const elementOnly = applyReferenceReaction(
      transition({ current: both, input: { expectedRevision: 2, ensemble: false, elements: ["colors"] } }),
    );
    expect(elementOnly).toMatchObject({ ensemble: false, elements: ["colors"] });
  });
  it.each([
    { elements: ["logo", "logo"] },
    { elements: ["unknown"] },
    { elements: ["ensemble"] },
    { elements: ["images"] },
  ])("rejects duplicate, unknown or irrelevant reactions %j", ({ elements }) => {
    expect(() =>
      applyReferenceReaction(transition({ input: { expectedRevision: 0, ensemble: false, elements } })),
    ).toThrow();
  });
  it.each(["ownerId", "projectId", "referenceId", "media", "provider", "model", "used", "revision"])(
    "rejects browser-controlled %s",
    (field) => {
      expect(
        setReferenceReactionSchema.safeParse({ expectedRevision: 0, ensemble: true, elements: [], [field]: id(99) })
          .success,
      ).toBe(false);
    },
  );
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"])("rejects invalid expected revision %s", (expectedRevision) => {
    expect(setReferenceReactionSchema.safeParse({ expectedRevision, ensemble: false, elements: [] }).success).toBe(
      false,
    );
  });
  it("rejects stale expected revisions without mutating the current reaction", () => {
    const current = entry().reaction,
      before = structuredClone(current);
    expect(() => applyReferenceReaction(transition({ current }))).toThrow(/conflict/i);
    expect(current).toEqual(before);
  });
  it("does not wrap or round an exhausted revision counter", () => {
    const current = { ...entry().reaction, revision: Number.MAX_SAFE_INTEGER };
    expect(() =>
      applyReferenceReaction(
        transition({ current, input: { expectedRevision: Number.MAX_SAFE_INTEGER, ensemble: true, elements: [] } }),
      ),
    ).toThrow();
    expect(current.revision).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([{ actorId: id(99) }, { projectId: id(98) }])(
    "rejects a reference outside the verified scope %j",
    (patch) => {
      expect(() => applyReferenceReaction(transition(patch))).toThrow();
    },
  );
  it.each([{ referenceId: id(99) }, { ownerId: id(99) }, { projectId: id(98) }])(
    "rejects mismatched current reaction %j",
    (patch) => {
      expect(() =>
        applyReferenceReaction(
          transition({
            current: { ...entry().reaction, ...patch },
            input: { expectedRevision: 1, ensemble: true, elements: [] },
          }),
        ),
      ).toThrow();
    },
  );
  it("supports an explicit empty reaction at revision zero but rejects invented prior likes", () => {
    const value = entry();
    expect(
      identityReferenceEntrySchema.safeParse({
        ...value,
        reaction: { ...value.reaction, revision: 0, ensemble: false, elements: [], updatedAt: null },
      }).success,
    ).toBe(true);
    expect(
      identityReferenceEntrySchema.safeParse({
        ...value,
        reaction: { ...value.reaction, revision: 0, updatedAt: null },
      }).success,
    ).toBe(false);
  });
  it("rejects a same-owner cross-project media link before a reaction can be accepted", () => {
    const value = reference();
    value.media.projectId = id(99);
    expect(() => applyReferenceReaction(transition({ reference: value }))).toThrow();
  });
});

describe("immutable selected-reference snapshots and material basis", () => {
  it("freezes exact selected records and canonicalizes sets without changing input", () => {
    const entries = [entry(2, true, []), entry(1, false, ["colors", "logo"])];
    const input = snapshotInput(entries),
      before = structuredClone(input);
    const snapshot = createIdentityReferenceSnapshot(input);
    expect(snapshot.selected.map((item) => item.reference.id)).toEqual([id(1), id(2)]);
    expect(snapshot.selected[0]!.reaction.elements).toEqual(["logo", "colors"]);
    expect(snapshot.selected[0]!.reference.media.versionId).toBe(id(201));
    expect(snapshot.selected[0]!.reference.attribution).toEqual(reference().attribution);
    expect(snapshot.referenceRevision).toBe(1);
    expect(input).toEqual(before);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.selected)).toBe(true);
    expect(Object.isFrozen(snapshot.selected[0]!.reference.media)).toBe(true);
    expect(Object.isFrozen(snapshot.selected[0]!.reaction.elements)).toBe(true);
    entries[0]!.reference.attribution.label = "Later edit";
    expect(snapshot.selected[1]!.reference.attribution.label).toBe("Synthetic reference");
  });
  it("empty selection is an honest snapshot, not an invented preference", () => {
    const snapshot = createIdentityReferenceSnapshot(snapshotInput([]));
    expect(snapshot.selected).toEqual([]);
    expect(identityReferenceBasis(snapshot).references).toEqual([]);
  });
  it("requires the authoritative selected count and rejects a filtered or partial page", () => {
    const withoutCount: Record<string, unknown> = snapshotInput();
    delete withoutCount.selectedReferenceCount;
    expect(identityReferenceSnapshotSchema.safeParse({ version: 1, ...withoutCount }).success).toBe(false);
    expect(() => createIdentityReferenceSnapshot({ ...snapshotInput(), selectedReferenceCount: 2 })).toThrow();
    expect(() => createIdentityReferenceSnapshot({ ...snapshotInput([]), selectedReferenceCount: 1 })).toThrow();
  });
  it("compares the complete material set independently of source/page ordering", () => {
    const first = snapshotInput([entry(2, true, ["colors", "logo"]), entry(1, false, ["typography"])]);
    const second = snapshotInput([entry(1, false, ["typography"]), entry(2, true, ["logo", "colors"])]);
    expect(identityReferenceBasis(createIdentityReferenceSnapshot(first))).toEqual(
      identityReferenceBasis(createIdentityReferenceSnapshot(second)),
    );
  });
  it.each([
    { ownerId: id(99) },
    { projectId: id(98) },
    { referenceRevision: -1 },
    { version: 2 },
    { selected: [entry(), entry()] },
    { selected: [entry(1, false, [])] },
  ])("rejects malformed or incomplete selection snapshots %j", (patch) => {
    expect(identityReferenceSnapshotSchema.safeParse({ version: 1, ...snapshotInput(), ...patch }).success).toBe(false);
  });
  it("rejects a snapshot with a reaction from another reference", () => {
    const value = entry();
    value.reaction.referenceId = id(99);
    expect(() => createIdentityReferenceSnapshot(snapshotInput([value]))).toThrow();
  });
  it("does not treat revision, time, attribution or catalog tag changes as different selected content", () => {
    const original = createIdentityReferenceSnapshot(snapshotInput());
    const next = snapshotInput();
    next.referenceRevision = 99;
    next.capturedAt = "2026-10-05T11:00:00Z";
    next.selected[0]!.reaction.revision = 22;
    next.selected[0]!.reaction.updatedAt = next.capturedAt;
    next.selected[0]!.reference.createdAt = next.capturedAt;
    next.selected[0]!.reference.attribution.label = "Updated attribution";
    next.selected[0]!.reference.tags = ["another-real-tag"];
    expect(identityReferenceBasis(createIdentityReferenceSnapshot(next))).toEqual(identityReferenceBasis(original));
  });
  it.each(["ensemble", "elements", "referenceId", "mediaVersion", "mediaHash"])(
    "changes the material basis for a changed %s",
    (change) => {
      const original = createIdentityReferenceSnapshot(snapshotInput()),
        next = snapshotInput();
      const selected = next.selected[0]!;
      if (change === "ensemble") selected.reaction.ensemble = true;
      if (change === "elements") selected.reaction.elements = ["colors"];
      if (change === "referenceId") {
        selected.reference.id = id(99);
        selected.reaction.referenceId = id(99);
      }
      if (change === "mediaVersion") selected.reference.media.versionId = id(999);
      if (change === "mediaHash") selected.reference.media.contentHash = "b".repeat(64);
      expect(identityReferenceBasis(createIdentityReferenceSnapshot(next))).not.toEqual(
        identityReferenceBasis(original),
      );
    },
  );
  it("bounds complete selections rather than silently truncating them to a page", () => {
    expect(() =>
      createIdentityReferenceSnapshot(snapshotInput(Array.from({ length: 101 }, (_, index) => entry(index + 1)))),
    ).toThrow();
  });
});

describe("reference pages, source tags and availability", () => {
  it("uses bounded query defaults with no invented style taxonomy", () => {
    expect(identityReferenceQuerySchema.parse({})).toEqual({ limit: 40, excludedTags: [] });
    expect(
      validateIdentityReferenceQuery(
        { excludedTags: ["actual-source-tag"] },
        ["actual-source-tag", "another-tag"],
        projectId,
      ),
    ).toMatchObject({ excludedTags: ["actual-source-tag"] });
    expect(() =>
      validateIdentityReferenceQuery({ excludedTags: ["invented-style"] }, ["actual-source-tag"], projectId),
    ).toThrow();
  });
  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: "20" },
    { excludedTags: ["a", "a"] },
    { excludedTags: [""] },
    { cursor: { referenceId: id(1) } },
    { ownerId },
    { url: "https://example.invalid/feed" },
  ])("rejects unsafe or malformed query %j", (input) => {
    expect(identityReferenceQuerySchema.safeParse(input).success).toBe(false);
  });
  it("source-unconfigured is a strict state, never a fabricated page", () => {
    const unavailable = { status: "unavailable", reason: "reference_source_unconfigured" };
    expect(referenceSourceResultSchema.parse(unavailable)).toEqual(unavailable);
    expect(referenceSourceResultSchema.safeParse({ ...unavailable, items: [reference()] }).success).toBe(false);
  });
  it("cannot reuse a cursor under another project or changed exclusion filters", () => {
    const cursor = { projectId, createdAt: now, referenceId: id(1), excludedTags: ["real-tag"] };
    expect(identityReferenceQuerySchema.safeParse({ excludedTags: ["real-tag"], cursor }).success).toBe(true);
    expect(identityReferenceQuerySchema.safeParse({ excludedTags: [], cursor }).success).toBe(false);
    expect(() =>
      validateIdentityReferenceQuery({ excludedTags: ["real-tag"], cursor }, ["real-tag"], id(99)),
    ).toThrow();
  });
  it("requires cursor scope and filter provenance instead of accepting an unbound position", () => {
    expect(identityReferenceQuerySchema.safeParse({ cursor: { createdAt: now, referenceId: id(1) } }).success).toBe(
      false,
    );
  });
  it("validates exact source ownership and only real source tags", () => {
    const available = {
      status: "available",
      ownerId,
      projectId,
      query: identityReferenceQuerySchema.parse({}),
      tagsComplete: true,
      availableTags: ["synthetic-tag"],
      references: { items: [reference()], nextCursor: null },
    };
    expect(referenceSourceResultSchema.safeParse(available).success).toBe(true);
    for (const patch of [
      { ownerId: id(99) },
      { projectId: id(98) },
      { tagsComplete: true, availableTags: [] },
      { references: { items: [reference(), reference()], nextCursor: null } },
    ]) {
      expect(referenceSourceResultSchema.safeParse({ ...available, ...patch }).success).toBe(false);
    }
  });
  it("binds a continuation cursor to the last actual record and never accepts a cursor on an empty page", () => {
    const available = {
      status: "available",
      ownerId,
      projectId,
      query: identityReferenceQuerySchema.parse({}),
      tagsComplete: true,
      availableTags: ["synthetic-tag"],
      references: {
        items: [reference()],
        nextCursor: { projectId, excludedTags: [], createdAt: now, referenceId: id(1) },
      },
    };
    expect(referenceSourceResultSchema.safeParse(available).success).toBe(true);
    expect(
      referenceSourceResultSchema.safeParse({
        ...available,
        references: {
          ...available.references,
          nextCursor: { ...available.references.nextCursor, referenceId: id(99) },
        },
      }).success,
    ).toBe(false);
    expect(
      referenceSourceResultSchema.safeParse({
        ...available,
        references: { ...available.references, nextCursor: { ...available.references.nextCursor, projectId: id(99) } },
      }).success,
    ).toBe(false);
    expect(
      referenceSourceResultSchema.safeParse({
        ...available,
        references: {
          ...available.references,
          nextCursor: { ...available.references.nextCursor, excludedTags: ["synthetic-tag"] },
        },
      }).success,
    ).toBe(false);
    expect(
      referenceSourceResultSchema.safeParse({ ...available, references: { ...available.references, items: [] } })
        .success,
    ).toBe(false);
  });
  it("a reference overview binds every reaction, media version and page to its verified project", () => {
    const overview = {
      ownerId,
      projectId,
      query: identityReferenceQuerySchema.parse({}),
      referenceRevision: 1,
      selectedReferenceCount: 1,
      feed: { status: "available" },
      tagsComplete: true,
      availableTags: ["synthetic-tag"],
      references: { items: [entry()], nextCursor: null },
    };
    expect(identityReferencesOverviewSchema.safeParse(overview).success).toBe(true);
    expect(identityReferencesOverviewSchema.safeParse({ ...overview, projectId: id(99) }).success).toBe(false);
    const other = entry();
    other.reaction.ownerId = id(99);
    expect(
      identityReferencesOverviewSchema.safeParse({ ...overview, references: { items: [other], nextCursor: null } })
        .success,
    ).toBe(false);
  });
  it("requires the response to echo its validated query instead of an unbound reference page", () => {
    expect(
      referenceSourceResultSchema.safeParse({
        status: "available",
        ownerId,
        projectId,
        tagsComplete: true,
        availableTags: ["synthetic-tag"],
        references: { items: [reference()], nextCursor: null },
      }).success,
    ).toBe(false);
    expect(
      identityReferencesOverviewSchema.safeParse({
        ownerId,
        projectId,
        referenceRevision: 1,
        selectedReferenceCount: 1,
        feed: { status: "available" },
        tagsComplete: true,
        availableTags: ["synthetic-tag"],
        references: { items: [entry()], nextCursor: null },
      }).success,
    ).toBe(false);
  });
  it.each(["source", "overview"])("enforces the %s query's page limit, project and excluded rows", (kind) => {
    const page = {
      ownerId,
      projectId,
      query: identityReferenceQuerySchema.parse({ limit: 1 }),
      tagsComplete: true,
      availableTags: ["synthetic-tag"],
      references: { items: kind === "source" ? [reference()] : [entry()], nextCursor: null },
    };
    const value =
      kind === "source"
        ? { ...page, status: "available" }
        : { ...page, referenceRevision: 1, selectedReferenceCount: 2, feed: { status: "available" } };
    const schema = kind === "source" ? referenceSourceResultSchema : identityReferencesOverviewSchema;
    expect(schema.safeParse(value).success).toBe(true);
    expect(
      schema.safeParse({
        ...value,
        references: { items: kind === "source" ? [reference(), reference(2)] : [entry(), entry(2)], nextCursor: null },
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...value, query: { ...page.query, excludedTags: ["synthetic-tag"] } }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        ...value,
        query: { ...page.query, cursor: { projectId: id(99), referenceId: id(7), createdAt: now, excludedTags: [] } },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...value,
        tagsComplete: true,
        availableTags: ["synthetic-tag", "other-tag"],
        references: {
          ...page.references,
          nextCursor: { projectId, referenceId: id(1), createdAt: now, excludedTags: ["other-tag"] },
        },
      }).success,
    ).toBe(false);
  });
  it("retains real persisted references and selections when the discovery source disconnects", () => {
    const value = {
      ownerId,
      projectId,
      referenceRevision: 1,
      selectedReferenceCount: 1,
      query: identityReferenceQuerySchema.parse({}),
      feed: { status: "unavailable", reason: "reference_source_unconfigured" },
      tagsComplete: true,
      availableTags: ["synthetic-tag"],
      references: { items: [entry()], nextCursor: null },
    };
    const parsed = identityReferencesOverviewSchema.parse(value);
    expect(parsed.feed.status).toBe("unavailable");
    expect(parsed.references.items[0]!.reaction.elements).toEqual(["logo", "colors"]);
    expect(parsed.selectedReferenceCount).toBe(1);
  });
});

describe("bounded real tag metadata and neutral mutation receipts", () => {
  it("admits more than 50 real response tags while retaining individual reference and exclusion bounds", () => {
    const items = [1, 2].map((index) => ({
      ...reference(index),
      tags: Array.from({ length: 50 }, (_, n) => `tag-${index}-${n}`),
    }));
    const availableTags = items.flatMap((item) => item.tags);
    const value = {
      status: "available",
      ownerId,
      projectId,
      query: { limit: 2, excludedTags: [] },
      availableTags,
      tagsComplete: false,
      references: { items, nextCursor: null },
    };
    expect(referenceSourceResultSchema.parse(value).status).toBe("available");
    expect(
      validateIdentityReferenceQuery({ excludedTags: [availableTags[99]] }, availableTags, projectId).excludedTags,
    ).toEqual([availableTags[99]]);
    expect(identityReferenceSchema.safeParse({ ...items[0], tags: availableTags }).success).toBe(false);
    expect(identityReferenceQuerySchema.safeParse({ excludedTags: availableTags }).success).toBe(false);
    expect(referenceSourceResultSchema.safeParse({ ...value, tagsComplete: undefined }).success).toBe(false);
  });
  it("bounds suggestions plus full page/query coverage without asserting an overall project tag cap", () => {
    const availableTags = Array.from({ length: 5100 }, (_, n) => `tag-${n}`);
    const value = {
      ownerId,
      projectId,
      query: { excludedTags: ["tag-5099"] },
      referenceRevision: 0,
      selectedReferenceCount: 0,
      feed: { status: "unavailable", reason: "reference_source_unconfigured" },
      tagsComplete: false,
      availableTags,
      references: { items: [], nextCursor: null },
    };
    expect(identityReferencesOverviewSchema.parse(value).tagsComplete).toBe(false);
    expect(
      identityReferencesOverviewSchema.safeParse({ ...value, availableTags: [...availableTags, "one-too-many"] })
        .success,
    ).toBe(false);
    expect(
      identityReferencesOverviewSchema.safeParse({ ...value, availableTags: availableTags.slice(0, 50) }).success,
    ).toBe(false);
  });
  it("binds the exact mutation entry, aggregate revision and selected count without inventing a page", () => {
    const value = { ownerId, projectId, referenceRevision: 1, selectedReferenceCount: 1, entry: entry() };
    expect(setReferenceReactionResponseSchema.parse(value)).toEqual(value);
    for (const patch of [
      { ownerId: id(99) },
      { projectId: id(99) },
      { referenceRevision: 0 },
      { selectedReferenceCount: 0 },
      { query: {} },
    ])
      expect(setReferenceReactionResponseSchema.safeParse({ ...value, ...patch }).success).toBe(false);
  });
});

it("canonicalizes valid Unicode tags by code point, matching PostgreSQL COLLATE C", () => {
  expect(identityReferenceSchema.parse({ ...reference(), tags: ["😀", "\uE000", "A"] }).tags).toEqual([
    "A",
    "\uE000",
    "😀",
  ]);
  expect(identityReferenceQuerySchema.parse({ excludedTags: ["😀", "\uE000"] }).excludedTags).toEqual(["\uE000", "😀"]);
});

it.each([
  "https://[::1]/",
  "https://éxample.invalid/",
  "https://example.invalid/café",
  "https://example.invalid:0/",
  "https://example.invalid:080/",
  "https://example.invalid/%zz",
  "https://example.invalid./",
  "https://xn--a/",
  "https://xn--abc/",
  "https://xn--caf-dma.example/",
  "https://example.xn--p1ai/",
])("documents the conservative stored attribution URL subset: %s", (sourceUrl) => {
  const value = reference();
  value.attribution.sourceUrl = sourceUrl;
  expect(identityReferenceSchema.safeParse(value).success).toBe(false);
});
