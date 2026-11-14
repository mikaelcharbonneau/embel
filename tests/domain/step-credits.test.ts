import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_MONTHLY_CREDITS } from "@/domain/billing";
import {
  COMPLETE_BRAND_CREDITS,
  COMPLETE_BRAND_CREDITS_REQUIRED,
  completeBrandsPerMonth,
  STEP_CREDITS,
} from "@/domain/step-credits";

/** The credits each generation kind charges once every migration has run, read from the SQL itself. */
function migratedKindCredits() {
  const dir = "supabase/migrations";
  const credits = new Map<string, number>();
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    const pattern =
      /INSERT INTO fluid_private\.generation_kinds \(kind, credits[^)]*\) VALUES \('([^']+)', (\d+)|update fluid_private\.generation_kinds set credits = (\d+) where kind = '([^']+)'/giu;
    for (const match of sql.matchAll(pattern)) {
      if (match[1]) credits.set(match[1], Number(match[2]));
      else credits.set(match[4]!, Number(match[3]));
    }
  }
  return credits;
}

function migratedPlanCredits() {
  const dir = "supabase/migrations";
  const credits = new Map<string, number>();
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const match of sql.matchAll(/update fluid_private\.plans set monthly_credits = (\d+) where id = '([^']+)'/giu))
      credits.set(match[2]!, Number(match[1]));
  }
  return credits;
}

describe("credits per step on the Plans page", () => {
  it("states exactly what the server charges for every paid step", () => {
    const charged = migratedKindCredits();
    for (const row of STEP_CREDITS.filter((item) => item.kind))
      expect([row.kind, row.credits]).toEqual([row.kind, charged.get(row.kind!)]);
    for (const row of STEP_CREDITS.filter((item) => !item.kind)) expect(row.credits).toBe(0);
  });

  it("matches the monthly allowances the database grants", () => {
    const granted = migratedPlanCredits();
    for (const [plan, credits] of Object.entries(PLAN_MONTHLY_CREDITS)) expect(granted.get(plan)).toBe(credits);
  });

  it("turns an allowance into complete brands", () => {
    expect(COMPLETE_BRAND_CREDITS).toBe(19);
    expect(COMPLETE_BRAND_CREDITS_REQUIRED).toBe(18);
    expect(completeBrandsPerMonth(30)).toBe(1);
    expect(completeBrandsPerMonth(150)).toBe(7);
    expect(completeBrandsPerMonth(500)).toBe(26);
  });
});
