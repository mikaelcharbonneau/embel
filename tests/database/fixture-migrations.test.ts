import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { fixtureMigrationNames } from "./fixture-migrations";

const lifecycle = "local20261007014000_home_lifecycle.sql";
const attachments = "20261007015000_home_attachments.sql";
const inputs = "local20261007017000_logo_inputs.sql";
const worker = "20261008010153_restricted_api_text_runtime.sql";
const conflict = "20261008033000_workspace_business_conflict_codes.sql";
const directory = new URL("../../supabase/migrations/", import.meta.url);

describe("local fixture migration chronology", () => {
  it("orders local-prefixed and recorded migrations by their timestamp without renaming files", () => {
    const files = [conflict, inputs, worker, attachments, lifecycle];
    expect(fixtureMigrationNames(files)).toEqual([lifecycle, attachments, inputs, worker, conflict]);
    expect(files).toEqual([conflict, inputs, worker, attachments, lifecycle]);
  });
  it("uses the same chronology for historical fixture cutoffs, excluding future migrations", () => {
    const files = [conflict, worker, inputs, attachments, lifecycle];
    expect(fixtureMigrationNames(files, inputs)).toEqual([lifecycle, attachments]);
    expect(fixtureMigrationNames(files, attachments)).toEqual([lifecycle]);
  });
  it("keeps all SQL files with deterministic tie order and ignores non-SQL entries", () => {
    const numbered = "20261007014000_home_lifecycle.sql";
    expect(fixtureMigrationNames([lifecycle, "README.md", numbered, "directory", "draft.sql.bak"]))
      .toEqual([numbered, lifecycle]);
  });
  it.each(["unversioned.sql", "local20261007_short.sql", "20261008033000.sql"])("fails clearly on an unrecognized SQL filename: %s", name => {
    expect(() => fixtureMigrationNames([name])).toThrow(`Unrecognized fixture migration filename: ${name}`);
  });
  it("also validates an explicit cutoff", () => {
    expect(() => fixtureMigrationNames([], "unversioned.sql")).toThrow("Unrecognized fixture migration filename: unversioned.sql");
  });
  it("keeps the durable migration byte-identical to the reviewed candidate and after both local prerequisites", async () => {
    const files = await readdir(directory), ordered = fixtureMigrationNames(files);
    expect(ordered).toHaveLength(files.filter(name => name.endsWith(".sql")).length);
    expect(ordered.indexOf(lifecycle)).toBeLessThan(ordered.indexOf(attachments));
    expect(ordered.indexOf(attachments)).toBeLessThan(ordered.indexOf(inputs));
    expect(ordered.indexOf(inputs)).toBeLessThan(ordered.indexOf(conflict));
    expect(await readFile(new URL(conflict, directory), "utf8"))
      .toBe(await readFile(new URL("../../supabase/candidates/workspace_business_conflict_codes.sql", import.meta.url), "utf8"));
  });
});
