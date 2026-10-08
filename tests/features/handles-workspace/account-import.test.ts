import { describe, expect, it } from "vitest";
import { standaloneImportSourceSchema, type StandaloneImportSource } from "@/domain/standalone-workspaces";
import { handlesAccountSourceLabel, handlesImportedName, importHandlesName } from "@/components/tools/handles-account-adapter";
import { buildHandleMatrix, createEntry, emptyHandlesState, handleStatus, type HandlesState } from "@/features/handles-workspace/domain";
import { parseHandlesDraft } from "@/features/handles-workspace/account-codec";

const source: StandaloneImportSource = { projectId: "00000000-0000-4000-8000-000000000001", projectRevision: 2, projectTitle: "Fixture project", name: "Fixture", selectionId: "00000000-0000-4000-8000-000000000002", candidateId: "00000000-0000-4000-8000-000000000003", origin: "naming_selection" };

describe("Handles explicit owned-name projection", () => {
  it("imports only a source choice, never a selected bundle, platform result or reservation", () => {
    const input = emptyHandlesState(), next = importHandlesName(source, input);
    expect(next).toEqual(input); expect(next).not.toBe(input);
    const imported = handlesImportedName(source);
    expect(imported).toMatchObject({ name: "Fixture", origin: "names", projectId: source.projectId });
    const [row] = buildHandleMatrix([imported], ["instagram", "x"]);
    expect(row!.entries.every(entry => handleStatus(entry) === "to_check" && !entry.selected && !entry.favorite && !entry.accountCreated && !entry.evidence.length)).toBe(true);
  });

  it("retains existing bundles/declarations and labels the exact frozen import after reload", () => {
    const imported = handlesImportedName(source);
    const input: HandlesState = { version: 1, bundles: [{ id: "bundle", title: "Fixture", list: "Personal", savedAt: "2026-10-05T12:00:00Z", source: imported, entries: [createEntry("x", "fixture")] }] };
    const reloaded = parseHandlesDraft(JSON.parse(JSON.stringify(importHandlesName(source, input))));
    expect(reloaded).toEqual(input);
    expect(handlesAccountSourceLabel(reloaded.bundles[0]!.source, [source])).toContain("revision 2");
    expect(handlesAccountSourceLabel(reloaded.bundles[0]!.source, [])).toBe("User-entered source label");
  });

  it("cannot forge a resolved import by changing a payload label, even with a valid imported source ID", () => {
    const imported = handlesImportedName(source);
    for (const patch of [{ name: "Forged" }, { origin: "manual" as const }, { projectId: "foreign-project" }, { projectTitle: "Other project" }, { id: "other" }]) {
      expect(handlesAccountSourceLabel({ ...imported, ...patch }, [source])).toBe("User-entered source label");
    }
    expect(handlesAccountSourceLabel(imported, [{ ...source, projectRevision: 3 }])).toBe("User-entered source label");
  });

  it("rejects malformed/imported provider assertions and partial immutable source references", () => {
    for (const input of [null, { ...source, selectionId: null }, { ...source, candidateId: null }, { ...source, origin: "project_name" }, { ...source, ownerId: "foreign" }, { ...source, available: true }, { ...source, name: "a".repeat(161) }, { ...source, projectRevision: -1 }]) {
      expect(standaloneImportSourceSchema.safeParse(input).success).toBe(false);
      expect(() => importHandlesName(input as StandaloneImportSource, emptyHandlesState())).toThrow();
    }
  });

  it("accepts a saved supplied name without manufacturing Naming selection provenance", () => {
    const supplied = { ...source, selectionId: null, candidateId: null, origin: "project_name" as const };
    expect(handlesImportedName(supplied)).toMatchObject({ origin: "project", name: supplied.name });
    expect(handlesImportedName(supplied).id).not.toBe(handlesImportedName(source).id);
  });
});
