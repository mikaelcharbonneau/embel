import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { contextSnapshotSchema } from "../../src/domain/projects";
import { namingStrategyBasis } from "../../src/domain/project-naming";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { buildNamingRunInput, namingEngineEnabled, namingEngineRequest, namingRunInputSchema } from "../../src/server/engine/naming";

// The input a Naming run freezes, built from the owner's own saved data (synthetic fixtures).
const owner = "aaaaaaaa-1111-4111-8111-111111111111", project = "bbbbbbbb-2222-4222-8222-222222222222";
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => new Date(Date.parse("2026-11-09T12:00:00Z") + n * 1000).toISOString();
const context = contextSnapshotSchema.parse({ description: "Synthetic bakery brief", competitors: [], positioning: "Bread for offices" });
const preferences = { version: 2, creativeLocale: "en", notes: "Warm", minimumGraphemes: null, maximumGraphemes: 12, approaches: ["invented", "real_words"], directness: "all",
  sourceLanguages: [], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [] };
const candidate = (n: number, value = `Name${n}`) => ({ id: id(n), owner_id: owner, project_id: project, value, identity_key: value.toLowerCase(), rationale: `Why ${value}.`, created_at: at(n) });

type Rows = Record<string, unknown>[];
/** A read-only stand-in for the owner's Supabase client that applies eq/in filters, order and limit. */
function auth(tables: Record<string, Rows>, rpc: () => unknown = () => ({ data: null, error: null })): AuthenticatedContext {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])], count = Infinity;
    const orders: [string, number][] = [];
    const result = () => [...rows].sort((a, b) => {
      for (const [field, direction] of orders) { const order = String(a[field]).localeCompare(String(b[field])) * direction; if (order) return order; }
      return 0;
    }).slice(0, count);
    const builder: Record<string, unknown> = {
      select: () => builder, is: () => builder,
      eq: (field: string, value: unknown) => { rows = rows.filter(row => row[field] === value); return builder; },
      in: (field: string, values: unknown[]) => { rows = rows.filter(row => values.includes(row[field])); return builder; },
      order: (field: string, options: { ascending?: boolean } = {}) => { orders.push([field, options.ascending === false ? -1 : 1]); return builder; },
      limit: (value: number) => { count = value; return builder; },
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => void) => resolve({ data: result(), error: null }),
    };
    return builder;
  };
  return { userId: owner, client: { from, rpc: async () => rpc() } } as unknown as AuthenticatedContext;
}
function tables(overrides: Partial<Record<string, Rows>> = {}): Record<string, Rows> {
  return {
    projects: [{ id: project, owner_id: owner, scope: "complete_brand", title: "Synthetic", current_revision: 3, created_at: at(0) }],
    project_revisions: [{ project_id: project, owner_id: owner, revision: 3, context, input_hash: "x", created_at: at(0) }],
    naming_sessions: [{ owner_id: owner, project_id: project, preferences_version: 2 }],
    naming_preferences: [{ owner_id: owner, project_id: project, version: 2, preferences }],
    name_retention: [
      { owner_id: owner, project_id: project, candidate_id: id(2), liked: true, updated_at: at(50) },
      { owner_id: owner, project_id: project, candidate_id: id(3), liked: true, updated_at: at(60) },
      { owner_id: owner, project_id: project, candidate_id: id(4), liked: false, updated_at: at(70) },
    ],
    name_candidates: Array.from({ length: 60 }, (_, index) => candidate(index + 1)),
    jobs: [],
    ...overrides,
  };
}
const request = (overrides: Record<string, unknown> = {}) => ({ kind: "initial", expectedProjectRevision: 3, expectedPreferencesVersion: 2, seedIds: [], instruction: null, ...overrides });

describe("freezing a Naming run's input", () => {
  it("freezes the saved choices, the revision's strategy, likes, recent names and the newest identities", async () => {
    const input = await buildNamingRunInput(auth(tables()), project, request());
    expect(namingRunInputSchema.parse(input)).toEqual(input);
    expect(input).toMatchObject({ version: 1, kind: "initial", revision: 3, policy: { model: "gpt-6-luna", reasoningEffort: "low" } });
    expect(input.brief).toMatchObject({ contextRevision: 3, preferencesVersion: 2, preferences, strategyBasis: namingStrategyBasis(context), steeringInstruction: null, strongSeeds: [] });
    // Most recently liked first; a name that is no longer liked is left out.
    expect(input.brief.likedExamples).toEqual([{ value: "Name3" }, { value: "Name2" }]);
    expect(input.brief.recentExamples).toHaveLength(50);
    expect(input.brief.recentExamples[0]).toEqual({ value: "Name60" });
    // Oldest first, so a request's exclusion hint keeps the newest names.
    expect(input.exclusions).toHaveLength(60);
    expect(input.exclusions.at(-1)).toBe("name60");
  });
  it("freezes steering seeds and the typed instruction for a steered run", async () => {
    const input = await buildNamingRunInput(auth(tables()), project, request({ kind: "steer", seedIds: [id(9), id(5)], instruction: "  Warmer  " }));
    expect(input.brief.strongSeeds).toEqual([{ value: "Name5", rationale: "Why Name5." }, { value: "Name9", rationale: "Why Name9." }]);
    expect(input.brief.steeringInstruction).toBe("Warmer");
  });
  it("names the project's changes with the existing Naming codes", async () => {
    const failure = (value: Promise<unknown>) => value.then(() => null, (error: { code?: string }) => error.code);
    expect(await failure(buildNamingRunInput(auth(tables()), project, request({ expectedProjectRevision: 2 })))).toBe("project_revision_changed");
    expect(await failure(buildNamingRunInput(auth(tables()), project, request({ expectedPreferencesVersion: 1 })))).toBe("preferences_changed");
    expect(await failure(buildNamingRunInput(auth(tables({ naming_preferences: [{ owner_id: owner, project_id: project, version: 2, preferences: { ...preferences, approaches: [] } }] })), project, request()))).toBe("preferences_incomplete");
    expect(await failure(buildNamingRunInput(auth(tables()), project, request({ kind: "steer", seedIds: [id(999)] })))).toBe("invalid_naming_request");
    expect(await failure(buildNamingRunInput(auth(tables()), project, request({ kind: "more", instruction: "Not for More names" })))).toBe("invalid_naming_request");
    expect(await failure(buildNamingRunInput(auth(tables()), project, { ...request(), preferences }))).toBe("invalid_naming_request");
    expect(await failure(buildNamingRunInput(auth(tables({ projects: [] })), project, request()))).toBe("not_found");
  });
  it("keeps a large project's input inside start_generation's limit by dropping the oldest identities", async () => {
    const long = Array.from({ length: 1_000 }, (_, index) => candidate(index + 1, `Longname${"x".repeat(60)}${index}`));
    const input = await buildNamingRunInput(auth(tables({ name_candidates: long })), project, request());
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeLessThanOrEqual(56_000);
    expect(input.exclusions.length).toBeLessThan(1_000);
    expect(input.exclusions.at(-1)).toBe(`longname${"x".repeat(60)}999`);
  });
  it("maps a Naming screen request to what the engine freezes, keeping nothing else", () => {
    expect(namingEngineRequest({ version: 2, kind: "steer", expectedProjectRevision: 3, expectedPreferencesVersion: 2, seedIds: [id(1)], instruction: "Warmer", idempotencyKey: "screen-key-0123456789" }))
      .toEqual({ kind: "steer", expectedProjectRevision: 3, expectedPreferencesVersion: 2, seedIds: [id(1)], instruction: "Warmer" });
  });
});

describe("the Naming switch", () => {
  const catalog = (enabled: boolean) => () => ({ data: { plans: [], kinds: [{ kind: "engine.probe", credits: 0, enabled: true }, { kind: "naming.generate", credits: 1, enabled }] }, error: null });
  it("turns on only while naming.generate is enabled, and stays off when the catalog can't be read", async () => {
    expect(await namingEngineEnabled(auth({}, catalog(true)))).toBe(true);
    expect(await namingEngineEnabled(auth({}, catalog(false)))).toBe(false);
    expect(await namingEngineEnabled(auth({}, () => ({ data: null, error: { message: "function does not exist", code: "42883" } })))).toBe(false);
  });
});
