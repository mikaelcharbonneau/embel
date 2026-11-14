import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_RUN_STATUSES,
  GENERATION_RUN_STATUSES,
  GENERATION_RUN_TRANSITIONS,
  TERMINAL_RUN_STATUSES,
  canRunMove,
  canStopRun,
  isActiveRun,
  isRunStopping,
  isTerminalRunStatus,
  runPhase,
  startRefusal,
  type GenerationRunStatus,
} from "@/domain/generation-run";
import { generationRunSchema } from "@/domain/generations";

const migrations = join(process.cwd(), "supabase/migrations");
const sql = readdirSync(migrations)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(migrations, name), "utf8"));
const quoted = (text: string) => [...text.matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]!);
/** The newest definition of a function across the migrations, as its SQL text. */
function latestFunction(name: string): string {
  const pattern = new RegExp(
    `create (?:or replace )?function ${name.replace(".", "\\.")}\\([\\s\\S]*?\\n(?:end|\\$\\$)[^\\n]*\\$\\$`,
    "giu",
  );
  const found = sql.flatMap((text) => text.match(pattern) ?? []);
  expect(found.length, name).toBeGreaterThan(0);
  return found.at(-1)!;
}

describe("generation run lifecycle", () => {
  it("lists the statuses the database allows", () => {
    const checks = sql.flatMap(
      (text) => text.match(/CONSTRAINT generation_runs_status_check CHECK \(\(status = ANY \(ARRAY\[[^\]]+\]/gu) ?? [],
    );
    expect(checks.length).toBeGreaterThan(0);
    expect(quoted(checks.at(-1)!).sort()).toEqual([...GENERATION_RUN_STATUSES].sort());
  });

  it("calls a run active exactly where the database does", () => {
    const active = /status in \('queued', 'running'\)/u;
    expect(latestFunction("public.start_generation")).toMatch(active);
    // finish_generation_run leaves every run that is no longer active untouched.
    expect(latestFunction("fluid_private.finish_generation_run")).toMatch(/status not in \('queued', 'running'\)/u);
    expect([...ACTIVE_RUN_STATUSES]).toEqual(["queued", "running"]);
  });

  it("ends a run only with a status the database accepts as an ending", () => {
    const guard = latestFunction("fluid_private.finish_generation_run").match(/p_status not in \(([^)]+)\)/u);
    expect(quoted(guard![1]!).sort()).toEqual([...TERMINAL_RUN_STATUSES].sort());
  });

  it("splits every status into active or terminal, never both", () => {
    expect([...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES].sort()).toEqual([...GENERATION_RUN_STATUSES].sort());
    for (const status of GENERATION_RUN_STATUSES) {
      expect(isTerminalRunStatus(status)).toBe(!isActiveRun({ status }));
    }
  });

  it("lets nothing leave a terminal status and gives every active status an ending", () => {
    for (const status of TERMINAL_RUN_STATUSES) expect(GENERATION_RUN_TRANSITIONS[status]).toEqual([]);
    for (const status of ACTIVE_RUN_STATUSES) {
      expect(GENERATION_RUN_TRANSITIONS[status].some((next) => isTerminalRunStatus(next))).toBe(true);
    }
    expect(canRunMove("queued", "running")).toBe(true);
    expect(canRunMove("running", "queued")).toBe(false);
    // A run that never started cannot have succeeded.
    expect(canRunMove("queued", "succeeded")).toBe(false);
    expect(canRunMove("succeeded", "failed")).toBe(false);
  });

  it("reads a stop request as stopping only while the run is still working", () => {
    const phase = (status: GenerationRunStatus, cancelRequested: boolean) => runPhase({ status, cancelRequested });
    expect(phase("queued", false)).toBe("queued");
    expect(phase("running", false)).toBe("running");
    expect(phase("queued", true)).toBe("stopping");
    expect(phase("running", true)).toBe("stopping");
    // The database keeps the stop request on a run that finished anyway.
    expect(phase("succeeded", true)).toBe("succeeded");
    expect(phase("failed", true)).toBe("failed");
    expect(phase("cancelled", true)).toBe("cancelled");
    expect(isRunStopping({ status: "succeeded", cancelRequested: true })).toBe(false);
  });

  it("offers Stop once: while working and not yet asked", () => {
    expect(canStopRun({ status: "running", cancelRequested: false })).toBe(true);
    expect(canStopRun({ status: "queued", cancelRequested: false })).toBe(true);
    expect(canStopRun({ status: "running", cancelRequested: true })).toBe(false);
    expect(canStopRun({ status: "cancelled", cancelRequested: true })).toBe(false);
  });

  it("is the status list the browser's run shape accepts", () => {
    expect(generationRunSchema.shape.status.options).toEqual([...GENERATION_RUN_STATUSES]);
  });

  it("treats a refusal as final only when it proves nothing started", () => {
    for (const status of [400, 401, 402, 403, 404, 409, 413, 422, 429]) expect(startRefusal(status)).toBe("final");
    // 503 can follow an admitted run whose workflow did not start; 500, 502 and 504 prove nothing either.
    for (const status of [500, 502, 503, 504, 0]) expect(startRefusal(status)).toBe("uncertain");
  });
});
