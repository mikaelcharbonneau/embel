import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { createTestDatabase, type TestDatabase } from "./local-supabase";

// Synthetic context only. The material context feeds identity inputs; the name given with
// Rename must not reach it (20261114120000_identity_context_ignores_display_name.sql).
const context = contextSnapshotSchema.parse({
  description: "Seasonal fruit boxes delivered to offices.",
  activity: "Fruit delivery",
  offering: "Weekly office fruit boxes",
  knownAudience: "Office managers",
  reformulationConfirmed: true,
  competitors: [
    {
      id: "10000000-0000-4000-8000-000000000011",
      name: "Orchard Office",
      relevance: "Same city, same offer",
      selected: true,
      origin: "user",
      sources: [],
    },
  ],
  competitorReviewComplete: true,
  positioning: "Fresh fruit that arrives before the first meeting.",
  selectedName: "Persimmon",
  intake: { suppliedName: "Persimmon", identityNotes: "Warm and plain." },
});

describe("identity material context and the project's display name", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  const material = async (value: unknown) =>
    (
      await db.query<{ v: unknown }>("select fluid_private.identity_material_context($1::jsonb) as v", [
        JSON.stringify(value),
      ])
    ).rows[0]!.v;

  it("accepts a context with displayName and yields exactly the material of the same context without it", async () => {
    const without = await material(context);
    const withName = await material({ ...context, displayName: "Spring launch" });
    expect(withName).toEqual(without);
    expect(JSON.stringify(withName)).not.toContain("Spring launch");
    expect(withName).toMatchObject({ selectedName: "Persimmon" });
    expect(withName).not.toHaveProperty("displayName");
  });

  it("still rejects any other unknown key and a context that is not an object", async () => {
    await expect(material({ ...context, displayLabel: "Spring launch" })).rejects.toThrow("invalid_identity_context");
    await expect(material({ ...context, displayName: "Spring launch", extra: true })).rejects.toThrow(
      "invalid_identity_context",
    );
    await expect(material(["displayName"])).rejects.toThrow("invalid_identity_context");
    await expect(material("displayName")).rejects.toThrow("invalid_identity_context");
  });

  it("keeps the function private, immutable and with an empty search path", async () => {
    const { rows } = await db.query<{ volatile: string; config: string[] | null; anon: boolean; signed: boolean }>(
      `select p.provolatile as volatile, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as signed
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'fluid_private' and p.proname = 'identity_material_context'`,
    );
    expect(rows).toEqual([{ volatile: "i", config: ['search_path=""'], anon: false, signed: false }]);
  });
});
