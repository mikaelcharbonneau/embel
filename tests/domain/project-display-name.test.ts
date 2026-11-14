import { describe, expect, it } from "vitest";
import { updateProjectInputSchema } from "../../src/domain/project-api";
import { contextDisplayName, contextSnapshotSchema } from "../../src/domain/projects";

describe("the name a project shows", () => {
  it("prefers the name given with Rename, then the chosen brand name, then nothing (the saved title)", () => {
    expect(contextDisplayName({ displayName: "Spring launch", selectedName: "Dayloaf" })).toBe("Spring launch");
    expect(contextDisplayName({ displayName: undefined, selectedName: " Dayloaf " })).toBe("Dayloaf");
    expect(contextDisplayName({ displayName: "  ", selectedName: "Dayloaf" })).toBe("Dayloaf");
    expect(contextDisplayName({ selectedName: null })).toBeNull();
    expect(contextDisplayName({ selectedName: "  " })).toBeNull();
  });
  it("reads revisions saved before Rename existed by the chosen brand name", () => {
    const old = contextSnapshotSchema.parse({ description: "A bakery", selectedName: "Dayloaf" });
    expect(old).not.toHaveProperty("displayName");
    expect(contextDisplayName(old)).toBe("Dayloaf");
  });
});

describe("saved context with a display name", () => {
  it("keeps old revisions valid and unchanged when they have no display name", () => {
    const parsed = contextSnapshotSchema.parse({ description: "A bakery", selectedName: "Dayloaf" });
    expect(Object.keys(parsed)).not.toContain("displayName");
    // Unchanged content keeps the same saved form, so its input hash does not move.
    expect(JSON.stringify(contextSnapshotSchema.parse(parsed))).toBe(JSON.stringify(parsed));
  });
  it("accepts a trimmed name of 1 to 160 characters and keeps it beside the brand name", () => {
    const parsed = contextSnapshotSchema.parse({ selectedName: "Dayloaf", displayName: "  Spring launch  " });
    expect(parsed.displayName).toBe("Spring launch");
    expect(parsed.selectedName).toBe("Dayloaf");
    expect(contextSnapshotSchema.parse({ displayName: "x".repeat(160) }).displayName).toHaveLength(160);
  });
  it("rejects an empty, blank, too long or non-text display name", () => {
    for (const displayName of ["", "   ", "x".repeat(161), 42, null])
      expect(contextSnapshotSchema.safeParse({ displayName }).success).toBe(false);
  });
  it("survives a later revision that copies the saved context", () => {
    const saved = contextSnapshotSchema.parse({ selectedName: "Dayloaf", displayName: "Spring launch" });
    const next = updateProjectInputSchema.parse({
      expectedRevision: 3,
      context: { ...saved, positioning: "Fresh bread for offices" },
    });
    expect(next.context.displayName).toBe("Spring launch");
    expect(next.context.selectedName).toBe("Dayloaf");
  });
});
