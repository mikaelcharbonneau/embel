import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, resetFixture, seedProject, type TestDatabase } from "./local-supabase";

// Migration 20261110120000_strategy_engine_kinds: the six Strategy operations as engine kinds.
let db: TestDatabase;
beforeAll(async () => { db = await createTestDatabase(); }, 180_000);
beforeEach(async () => {
  await resetFixture(db);
  await db.exec("update fluid_private.engine_settings set paused = false, global_daily_cost_cap_microusd = 50000000");
  await db.exec("update fluid_private.generation_kinds set enabled = false where kind like 'strategy.%'");
});

const operations = ["strategy.audience", "strategy.competitors", "strategy.personality", "strategy.positioning", "strategy.reformulate", "strategy.slogan"];
const key = (n: number) => `strategy.engine.v1:test:${String(n).padStart(4, "0")}`;
async function start(project: string, kind: string, k: string, input: object = { revision: 1 }) {
  return asRole(db, "authenticated", OWNER_A, async () =>
    (await db.query<{ id: string; credits: number; input: { revision: number } }>("select * from public.start_generation($1, $2, $3, $4::jsonb)", [project, kind, k, input])).rows[0]!);
}
async function failure(run: () => Promise<unknown>) {
  try { await run(); } catch (error) { return error as { message: string }; }
  throw new Error("Expected a failure");
}
const catalog = () => asRole(db, "authenticated", OWNER_A, async () =>
  (await db.query<{ c: { kinds: { kind: string; credits: number; enabled: boolean }[] } }>("select public.get_generation_catalog() as c")).rows[0]!.c.kinds);

describe("Strategy generation kinds", () => {
  it("lists every Strategy operation at one credit, disabled until released", async () => {
    const kinds = (await catalog()).filter(kind => kind.kind.startsWith("strategy."));
    expect(kinds.map(kind => kind.kind)).toEqual(operations);
    expect(kinds.every(kind => kind.credits === 1 && !kind.enabled)).toBe(true);
    const limits = Object.fromEntries((await db.query<{ kind: string; max_per_day: number }>("select kind, max_per_day from fluid_private.generation_kinds where kind like 'strategy.%'")).rows.map(row => [row.kind, row.max_per_day]));
    expect(limits).toEqual({ "strategy.reformulate": 100, "strategy.competitors": 20, "strategy.audience": 40, "strategy.positioning": 40, "strategy.personality": 40, "strategy.slogan": 40 });
  });

  it("refuses a disabled Strategy kind, then charges one credit once it is enabled", async () => {
    const project = await seedProject(db);
    expect((await failure(() => start(project.id, "strategy.competitors", key(1)))).message).toContain("generation_unavailable");
    await db.exec("update fluid_private.generation_kinds set enabled = true where kind like 'strategy.%'");
    const run = await start(project.id, "strategy.competitors", key(2));
    expect(run).toMatchObject({ credits: 1, input: { revision: 1 } });
    const balance = await asRole(db, "authenticated", OWNER_A, async () =>
      (await db.query<{ s: { balance: number } }>("select public.get_credit_summary() as s")).rows[0]!.s.balance);
    expect(balance).toBe(29);
    expect((await catalog()).filter(kind => kind.kind.startsWith("strategy.")).every(kind => kind.enabled)).toBe(true);
  });

  it("holds one active run per project and Strategy operation, independently per operation", async () => {
    const project = await seedProject(db);
    await db.exec("update fluid_private.generation_kinds set enabled = true where kind like 'strategy.%'");
    await start(project.id, "strategy.audience", key(1));
    expect((await failure(() => start(project.id, "strategy.audience", key(2)))).message).toContain("generation_active");
    expect((await start(project.id, "strategy.reformulate", key(3))).credits).toBe(1);
  });

  it("accepts a frozen Strategy input near the server's 56 KB budget", async () => {
    const project = await seedProject(db);
    await db.exec("update fluid_private.generation_kinds set enabled = true where kind = 'strategy.positioning'");
    // Mostly text with many keys and small numbers, like a late-journey project context.
    const items = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}`, label: "x".repeat(215), score: index, selected: index % 2 === 0 }));
    const input = { revision: 1, request: { version: 3, items } };
    const size = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    expect(size).toBeGreaterThan(50_000);
    expect(size).toBeLessThanOrEqual(56_000);
    expect((await start(project.id, "strategy.positioning", key(1), input)).input.revision).toBe(1);
  });
});
