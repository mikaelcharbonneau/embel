import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { projectDisplayName, readProjectDisplayNames } from "../../src/server/data/project-display-names";
import type { AuthenticatedContext } from "../../src/server/auth/context";

// Synthetic database responses only. No live account connection.
const owner = "aaaaaaaa-2222-4222-8222-222222222222";
const other = "bbbbbbbb-2222-4222-8222-222222222222";
const project = "cccccccc-2222-4222-8222-222222222222";

function fixture(response: { data: unknown; error: unknown }) {
  const selects: unknown[] = [];
  const client = {
    from: vi.fn(() => {
      const query = {
        select: (columns: unknown) => {
          selects.push(columns);
          return query;
        },
        eq: () => query,
        or: () => query,
        limit: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(response).then(resolve),
      };
      return query;
    }),
  };
  return { auth: { userId: owner, client } as unknown as AuthenticatedContext, selects };
}
const read = (rows: unknown[]) => {
  const f = fixture({ data: rows, error: null });
  return readProjectDisplayNames(f.auth, [{ id: project, current_revision: 4 }]).then((names) => ({
    names,
    selects: f.selects,
  }));
};

describe("project display names on lists", () => {
  it("reads the name given with Rename beside the chosen brand name in the same query", async () => {
    const { names, selects } = await read([
      { project_id: project, owner_id: owner, revision: 4, selected_name: "Dayloaf", display_name: " Spring launch " },
    ]);
    expect(names.get(project)).toBe("Spring launch");
    expect(selects).toEqual([
      "project_id,owner_id,revision,selected_name:context->>selectedName,display_name:context->>displayName",
    ]);
  });
  it("falls back to the chosen brand name for revisions without a display name", async () => {
    expect(
      (await read([{ project_id: project, owner_id: owner, revision: 4, selected_name: "Dayloaf" }])).names.get(
        project,
      ),
    ).toBe("Dayloaf");
    expect(
      (
        await read([
          { project_id: project, owner_id: owner, revision: 4, selected_name: "Dayloaf", display_name: null },
        ])
      ).names.get(project),
    ).toBe("Dayloaf");
  });
  it("keeps the saved title when the revision has no name or is not the current one", async () => {
    expect(
      (await read([{ project_id: project, owner_id: owner, revision: 4, selected_name: null }])).names.has(project),
    ).toBe(false);
    expect(
      (
        await read([{ project_id: project, owner_id: owner, revision: 3, selected_name: null, display_name: "Old" }])
      ).names.has(project),
    ).toBe(false);
    expect(projectDisplayName("Bike repair, Montreal", undefined, 160)).toBe("Bike repair, Montreal");
  });
  it("fails closed when a row belongs to another account", async () => {
    await expect(
      read([{ project_id: project, owner_id: other, revision: 4, selected_name: null, display_name: "Foreign" }]),
    ).rejects.toThrow();
  });
  it("shortens long names to the list's limit", () => {
    expect(projectDisplayName("Saved title", "x".repeat(170), 160)).toHaveLength(160);
    expect(projectDisplayName("Saved title", "x".repeat(170), 160).endsWith("…")).toBe(true);
  });
});
