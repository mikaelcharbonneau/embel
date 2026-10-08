import { describe, expect, it } from "vitest";
import { createProjectInputSchema, missingStrategy } from "../../src/domain/projects";
import * as m from "../../src/domain/ideas";

const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const foreignOwner = "bbbbbbbb-1111-4111-8111-111111111111";
const id = (value: number) => `cccccccc-1111-4111-8111-${String(value).padStart(12, "0")}`;
const createdAt = "2026-10-05T12:00:00.000002Z";
const updatedAt = "2026-10-05T12:05:00.000003Z";
const requestKey = id(90);
const detailKeys = ["problem", "audience", "solution", "differentiation", "revenueHypotheses", "validationSteps", "notes"] as const;
const emptyDetails = Object.fromEntries(detailKeys.map(key => [key, ""]));

const content = (overrides = {}) => ({ title: "Local synthetic idea", description: "A manually supplied description", theme: "Community", state: "to_explore", details: emptyDetails, ...overrides });
const summary = (value = 1, overrides = {}) => ({ id: id(value), ownerId: owner, revision: 1, title: "Local synthetic idea", description: "", theme: "", state: "to_explore", createdAt, updatedAt, ...overrides });
const link = (value = 10, overrides = {}) => ({ id: id(value), ownerId: owner, ideaId: id(1), ideaRevision: 1, projectId: id(value + 100), requestKey, createdAt, ...overrides });
const record = (overrides = {}) => ({ id: id(1), ownerId: owner, revision: 2, content: content(), createdAt, updatedAt, links: [link()], ...overrides });

describe("manual Idea content contracts (synthetic user-authored records)", () => {
  it("fills every optional content field for quick title-only capture", () => {
    expect(m.ideaContentSchema.parse({ title: "  Local synthetic idea  " })).toEqual({ title: "Local synthetic idea", description: "", theme: "", state: "to_explore", details: emptyDetails });
    expect(m.ideaContentSchema.parse({ title: "Local synthetic idea", details: { notes: "Manual note" } }).details).toEqual({ ...emptyDetails, notes: "Manual note" });
  });

  it("preserves source whitespace outside its normalized title", () => {
    const input = content({ title: "  Captured idea  ", description: "  original description\n", theme: " theme ", details: { ...emptyDetails, solution: "  original solution  ", notes: "\nnotes\n" } });
    expect(m.ideaContentSchema.parse(input)).toEqual({ ...input, title: "Captured idea" });
  });

  it.each(["to_explore", "developing", "used"])("accepts explicit state %s", state => {
    expect(m.ideaStateSchema.parse(state)).toBe(state);
  });

  it.each(["", "   ", "x".repeat(161), null, 4])("rejects invalid titles %j", title => {
    expect(m.ideaContentSchema.safeParse({ title }).success).toBe(false);
  });

  it("accepts exact title, description, theme and detail field limits", () => {
    const input = content({ title: "t".repeat(160), description: "d".repeat(12000), theme: "h".repeat(120), details: Object.fromEntries(detailKeys.map(key => [key, "n".repeat(2000)])) });
    expect(m.ideaContentSchema.parse(input)).toEqual(input);
  });

  it.each(["description", "theme"] as const)("rejects an oversized %s", field => {
    expect(m.ideaContentSchema.safeParse(content({ [field]: "x".repeat(field === "description" ? 12001 : 121) })).success).toBe(false);
  });

  it.each(detailKeys)("rejects an oversized optional %s", field => {
    expect(m.ideaContentSchema.safeParse(content({ details: { [field]: "x".repeat(2001) } })).success).toBe(false);
  });

  it.each([
    { ownerId: owner }, { approved: true }, { state: "approved" }, { description: null }, { details: null }, { details: { researched: true } },
  ])("rejects unknown, unapproved or malformed content %j", overrides => {
    expect(m.ideaContentSchema.safeParse(content(overrides)).success).toBe(false);
  });

  it("creates independent nested defaults for separate captured ideas", () => {
    const first = m.ideaContentSchema.parse({ title: "First" });
    const second = m.ideaContentSchema.parse({ title: "Second" });
    first.details.notes = "An edit to the first idea";
    expect(second.details.notes).toBe("");
  });

  it("publishes the aggregate UTF-8 cap separately from individual field limits", () => {
    expect(m.IDEA_MUTATION_MAX_BYTES).toBe(32768);
    const input = m.createIdeaInputSchema.parse({ requestKey, content: { title: "Byte-bound fixture", description: "界".repeat(12000) } });
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(m.IDEA_MUTATION_MAX_BYTES);
  });
});

describe("manual Idea client mutation and list inputs", () => {
  it("accepts owner-free create, edit and conversion requests", () => {
    expect(m.createIdeaInputSchema.parse({ requestKey, content: { title: "Capture" } })).toEqual({ requestKey, content: { title: "Capture", description: "", theme: "", state: "to_explore", details: emptyDetails } });
    expect(m.updateIdeaInputSchema.parse({ requestKey, expectedRevision: 1, content: content() }).expectedRevision).toBe(1);
    expect(m.createIdeaBrandInputSchema.parse({ requestKey, expectedRevision: 2 })).toEqual({ requestKey, expectedRevision: 2 });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "1", null])("rejects unsafe or invalid revision %j", expectedRevision => {
    expect(m.updateIdeaInputSchema.safeParse({ requestKey, expectedRevision, content: content() }).success).toBe(false);
    expect(m.createIdeaBrandInputSchema.safeParse({ requestKey, expectedRevision }).success).toBe(false);
    expect(m.ideaSummarySchema.safeParse(summary(1, { revision: expectedRevision })).success).toBe(false);
    expect(m.ideaRecordSchema.safeParse(record({ revision: expectedRevision })).success).toBe(false);
    expect(m.ideaLinkSchema.safeParse(link(10, { ideaRevision: expectedRevision })).success).toBe(false);
  });

  it("accepts the largest safe revision without rounding", () => {
    expect(m.createIdeaBrandInputSchema.parse({ requestKey, expectedRevision: Number.MAX_SAFE_INTEGER }).expectedRevision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(["ownerId", "ideaId", "context", "scope"])("rejects client-supplied %s in mutations", field => {
    expect(m.createIdeaInputSchema.safeParse({ requestKey, content: content(), [field]: owner }).success).toBe(false);
    expect(m.updateIdeaInputSchema.safeParse({ requestKey, expectedRevision: 1, content: content(), [field]: owner }).success).toBe(false);
    expect(m.createIdeaBrandInputSchema.safeParse({ requestKey, expectedRevision: 1, [field]: owner }).success).toBe(false);
  });

  it.each([undefined, "not-a-uuid", 3, null])("rejects malformed request keys %j", badKey => {
    expect(m.createIdeaInputSchema.safeParse({ requestKey: badKey, content: content() }).success).toBe(false);
    expect(m.updateIdeaInputSchema.safeParse({ requestKey: badKey, expectedRevision: 1, content: content() }).success).toBe(false);
    expect(m.createIdeaBrandInputSchema.safeParse({ requestKey: badKey, expectedRevision: 1 }).success).toBe(false);
  });

  it("defaults list bounds and trims literal search without inventing a state", () => {
    expect(m.listIdeasInputSchema.parse({})).toEqual({ limit: 25, search: "" });
    expect(m.listIdeasInputSchema.parse({ limit: 50, search: "  _%[literal]  ", state: "developing", cursor: { createdAt, id: id(1) } })).toEqual({ limit: 50, search: "_%[literal]", state: "developing", cursor: { createdAt, id: id(1) } });
  });

  it.each([{ limit: 0 }, { limit: 51 }, { limit: 2.5 }, { limit: "25" }, { search: "s".repeat(201) }, { state: "approved" }, { ownerId: owner }, { cursor: { id: id(1) } }, { cursor: { createdAt } }, { cursor: { id: id(1), createdAt, ownerId: owner } }])("rejects invalid list inputs %j", input => {
    expect(m.listIdeasInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("owned Idea response records and exact pagination", () => {
  it("accepts complete owned records, summaries and wrapped detail responses", () => {
    expect(m.ideaRecordSchema.parse(record())).toEqual(record());
    expect(m.ideaSummarySchema.parse(summary())).toEqual(summary());
    expect(m.ideaResponseSchema.parse({ idea: record() })).toEqual({ idea: record() });
  });

  it.each(["not-a-date", "2026-02-31T12:00:00Z", "2026-10-05T12:00:00.0000001Z", "2026-10-05T12:00:00Z),owner_id.neq.foreign"])("rejects invalid or over-precise timestamp %s", timestamp => {
    expect(m.ideaSummarySchema.safeParse(summary(1, { createdAt: timestamp })).success).toBe(false);
    expect(m.ideaRecordSchema.safeParse(record({ updatedAt: timestamp })).success).toBe(false);
    expect(m.ideaLinkSchema.safeParse(link(10, { createdAt: timestamp })).success).toBe(false);
  });

  it("rejects unknown response fields instead of silently stripping them", () => {
    expect(m.ideaSummarySchema.safeParse(summary(1, { approved: true })).success).toBe(false);
    expect(m.ideaRecordSchema.safeParse(record({ approval: true })).success).toBe(false);
    expect(m.ideaLinkSchema.safeParse(link(10, { source: "invented" })).success).toBe(false);
    expect(m.ideaResponseSchema.safeParse({ idea: record(), ownerId: owner }).success).toBe(false);
  });

  it.each([
    [link(10, { ownerId: foreignOwner })], [link(10, { ideaId: id(2) })], [link(10, { ideaRevision: 3 })],
    [link(), link()], [link(), link(11, { projectId: link().projectId })], [link(), link(11, { id: link().id.toUpperCase() })],
  ].map(links => ({ links })))("rejects foreign, future or duplicate record links %j", ({ links }) => {
    expect(m.ideaRecordSchema.safeParse(record({ links })).success).toBe(false);
  });

  it("bounds record links at 100", () => {
    const links = Array.from({ length: 100 }, (_, index) => link(index + 10));
    expect(m.ideaRecordSchema.safeParse(record({ links })).success).toBe(true);
    expect(m.ideaRecordSchema.safeParse(record({ links: [...links, link(200)] })).success).toBe(false);
  });

  it("retains exact timestamp spelling and submillisecond descending order", () => {
    const newer = summary(1);
    const older = summary(9, { createdAt: "2026-10-05T12:00:00.000001Z" });
    expect(Date.parse(newer.createdAt)).toBe(Date.parse(older.createdAt));
    const page = { ownerId: owner, items: [newer, older], nextCursor: { id: older.id, createdAt: older.createdAt } };
    expect(m.ideaPageSchema.parse(page)).toEqual(page);
    expect(m.ideaPageSchema.safeParse({ ...page, items: [older, newer], nextCursor: null }).success).toBe(false);
  });

  it("orders equal instants by descending UUID across timezone spellings", () => {
    const newer = summary(9, { createdAt: "2026-10-05T08:00:00.000002-04:00" });
    const older = summary(1);
    expect(m.ideaPageSchema.safeParse({ ownerId: owner, items: [newer, older], nextCursor: null }).success).toBe(true);
    expect(m.ideaPageSchema.safeParse({ ownerId: owner, items: [older, newer], nextCursor: null }).success).toBe(false);
  });

  it.each([
    [summary(9), summary(1, { ownerId: foreignOwner })], [summary(9), summary(9)], [summary(9), summary(9, { id: id(9).toUpperCase() })], [summary(1), summary(9)],
  ].map(items => ({ items })))("rejects foreign, duplicate or unsorted pages %j", ({ items }) => {
    expect(m.ideaPageSchema.safeParse({ ownerId: owner, items, nextCursor: null }).success).toBe(false);
  });

  it.each([
    { id: id(9), createdAt }, { id: id(1), createdAt: "2026-10-05T08:00:00.000002-04:00" }, { id: id(1), createdAt: "2026-10-05T12:00:00.000001Z" }, { id: id(1).toUpperCase(), createdAt },
  ])("rejects continuation without the exact final-row anchor %j", nextCursor => {
    expect(m.ideaPageSchema.safeParse({ ownerId: owner, items: [summary(9), summary(1)], nextCursor }).success).toBe(false);
  });

  it("permits an empty terminal page but never an empty page with continuation", () => {
    expect(m.ideaPageSchema.parse({ ownerId: owner, items: [], nextCursor: null })).toEqual({ ownerId: owner, items: [], nextCursor: null });
    expect(m.ideaPageSchema.safeParse({ ownerId: owner, items: [], nextCursor: { id: id(1), createdAt } }).success).toBe(false);
  });

  it("caps owned pages at 50 summaries and rejects extra envelope fields", () => {
    const items = Array.from({ length: 50 }, (_, index) => summary(50 - index));
    expect(m.ideaPageSchema.safeParse({ ownerId: owner, items, nextCursor: null }).success).toBe(true);
    expect(m.ideaPageSchema.safeParse({ ownerId: owner, items: [summary(51), ...items], nextCursor: null }).success).toBe(false);
    expect(m.ideaPageSchema.safeParse({ ownerId: owner, items, nextCursor: null, total: 50 }).success).toBe(false);
  });
});

describe("Idea conversion and frozen owned source responses", () => {
  it("binds conversion to the returned owned idea and an existing source revision", () => {
    expect(m.ideaBrandResponseSchema.parse({ idea: record(), link: link() })).toEqual({ idea: record(), link: link() });
  });

  it.each([{ ownerId: foreignOwner }, { ideaId: id(2) }, { ideaRevision: 3 }])("rejects unbound conversion receipts %j", overrides => {
    expect(m.ideaBrandResponseSchema.safeParse({ idea: record(), link: link(10, overrides) }).success).toBe(false);
  });

  it("binds a frozen source to both its returned owner and project", () => {
    const source = { link: link(), content: content({ state: "developing", details: { ...emptyDetails, revenueHypotheses: "A user-written hypothesis" } }) };
    expect(m.ideaSourceResponseSchema.parse({ ownerId: owner, projectId: link().projectId, source })).toEqual({ ownerId: owner, projectId: link().projectId, source });
    expect(m.ideaSourceResponseSchema.parse({ ownerId: owner, projectId: id(500), source: null })).toEqual({ ownerId: owner, projectId: id(500), source: null });
  });

  it.each([{ ownerId: foreignOwner }, { projectId: id(200) }])("rejects a cross-owner or cross-project source %j", overrides => {
    expect(m.ideaSourceResponseSchema.safeParse({ ownerId: owner, projectId: link().projectId, source: { link: link(10, overrides), content: content() } }).success).toBe(false);
  });

  it("rejects extra conversion and source envelope fields", () => {
    expect(m.ideaBrandResponseSchema.safeParse({ idea: record(), link: link(), project: {} }).success).toBe(false);
    expect(m.ideaSourceResponseSchema.safeParse({ ownerId: owner, projectId: link().projectId, source: { link: link(), content: content(), researched: true } }).success).toBe(false);
    expect(m.ideaSourceResponseSchema.safeParse({ ownerId: owner, projectId: link().projectId, source: null, approved: true }).success).toBe(false);
  });

  it("copies only known brand context, preserves source and requires all Strategy reviews", () => {
    const original = m.ideaContentSchema.parse(content({ title: "  A manual concept  ", description: "  A manual description\n", state: "developing", details: { problem: "Manual problem", audience: "  Known audience  ", solution: "  Known offering  ", differentiation: "Unreviewed differentiation", revenueHypotheses: "Unvalidated revenue hypothesis", validationSteps: "Proposed validation", notes: "Private notes" } }));
    const before = structuredClone(original);
    const project = m.ideaProjectInput(original);
    expect(project).toEqual(createProjectInputSchema.parse({ title: "A manual concept", scope: "complete_brand", context: { description: "A manual description", offering: "Known offering", knownAudience: "Known audience" } }));
    expect(missingStrategy(project.context)).toEqual(["reformulation", "competitors", "audience", "personality", "positioning"]);
    expect(project.context.intake).toEqual({ suppliedName: "", namingNotes: "", identityNotes: "", step: "review", audienceReviewedAt: null, personalityReviewedAt: null, positioningReviewedAt: null, example: false });
    expect(original).toEqual(before);
    project.context.description = "A separate brand edit";
    expect(original).toEqual(before);
  });

  it("uses the normalized title when the description is blank", () => {
    const original = m.ideaContentSchema.parse({ title: "  Manual title  ", description: "\n  " });
    expect(m.ideaProjectInput(original).context.description).toBe("Manual title");
    expect(original.description).toBe("\n  ");
  });
});
