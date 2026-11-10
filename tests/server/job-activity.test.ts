import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { listJobActivity } from "../../src/server/data/job-activity";
import type { AuthenticatedContext } from "../../src/server/auth/context";

// Synthetic database responses only. No provider or live account connection.
const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const other = "bbbbbbbb-1111-4111-8111-111111111111";
const project = "cccccccc-1111-4111-8111-111111111111";
const jobId = "dddddddd-1111-4111-8111-111111111111";
const when = "2026-10-04T03:00:00Z";
const row = {
  id: jobId,
  owner_id: owner,
  project_id: project,
  operation: "naming.generate",
  state: "running",
  progress: 0,
  created_at: when,
  finished_at: null,
};
function fixture(
  active: unknown[],
  recent: unknown[],
  projects: unknown[] = [{ id: project, owner_id: owner, title: "Synthetic project", current_revision: 2 }],
  error = false,
  revisions: { data: unknown; error: unknown } = { data: [], error: null },
) {
  const responses = [
    { data: active, error: error ? { code: "unavailable" } : null },
    { data: recent, error: null },
    { data: projects, error: null },
    revisions,
  ];
  const owners: unknown[][] = [],
    filters: unknown[] = [],
    tables: unknown[] = [];
  const client = {
    from: vi.fn((table: string) => {
      tables.push(table);
      const response = responses.shift();
      const query = {
        select: () => query,
        eq: (...args: unknown[]) => {
          owners.push(args);
          return query;
        },
        in: () => query,
        or: (filter: unknown) => {
          filters.push(filter);
          return query;
        },
        order: () => query,
        limit: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(response).then(resolve),
      };
      return query;
    }),
  };
  return { auth: { userId: owner, client } as unknown as AuthenticatedContext, owners, filters, tables, client };
}

describe("global job activity read boundary", () => {
  it("includes older active jobs, deduplicates recent rows and returns metadata only", async () => {
    const completed = { ...row, id: other, state: "succeeded", progress: 100, finished_at: when };
    const f = fixture([{ ...row, input: "private prompt", lease_token: "never return" }], [completed, row]);
    const result = await listJobActivity(f.auth);
    expect(result.active).toHaveLength(1);
    expect(result.recent).toHaveLength(1);
    expect(result.active[0]).toMatchObject({ id: jobId, projectTitle: "Synthetic project", state: "running" });
    expect(JSON.stringify(result)).not.toMatch(/private prompt|lease_token|never return/);
    expect(f.owners).toEqual(Array.from({ length: 4 }, () => ["owner_id", owner]));
  });
  it("names each project by its chosen brand name from the current saved revision", async () => {
    const f = fixture([row], [], undefined, false, {
      data: [{ project_id: project, owner_id: owner, revision: 2, selected_name: " Launchpad " }],
      error: null,
    });
    const result = await listJobActivity(f.auth);
    expect(result.active[0]?.projectTitle).toBe("Launchpad");
    expect(f.tables.at(-1)).toBe("project_revisions");
    expect(f.filters).toEqual([`and(project_id.eq.${project},revision.eq.2)`]);
  });
  it("keeps the saved title when no name is chosen, the revision differs or the name read fails", async () => {
    const older = {
      data: [{ project_id: project, owner_id: owner, revision: 1, selected_name: "Older name" }],
      error: null,
    };
    expect((await listJobActivity(fixture([row], [], undefined, false, older).auth)).active[0]?.projectTitle).toBe(
      "Synthetic project",
    );
    const unnamed = { data: [{ project_id: project, owner_id: owner, revision: 2, selected_name: null }], error: null };
    expect((await listJobActivity(fixture([row], [], undefined, false, unnamed).auth)).active[0]?.projectTitle).toBe(
      "Synthetic project",
    );
    expect(
      (await listJobActivity(fixture([row], [], undefined, false, { data: null, error: { code: "unavailable" } }).auth))
        .active[0]?.projectTitle,
    ).toBe("Synthetic project");
  });
  it("fails closed when a chosen-name row belongs to another account", async () => {
    const foreign = {
      data: [{ project_id: project, owner_id: other, revision: 2, selected_name: "Foreign private name" }],
      error: null,
    };
    await expect(listJobActivity(fixture([row], [], undefined, false, foreign).auth)).rejects.toThrow();
  });
  it.each(["job", "project"])("rejects a foreign %s even if a query returns it", async (boundary) => {
    const f =
      boundary === "job"
        ? fixture([{ ...row, owner_id: other }], [])
        : fixture([row], [], [{ id: project, owner_id: other, title: "Foreign private title", current_revision: 1 }]);
    await expect(listJobActivity(f.auth)).rejects.toThrow();
  });
  it("does not invent a project title when the owned association is missing", async () => {
    await expect(listJobActivity(fixture([row], [], []).auth)).rejects.toThrow();
  });
  it("fails closed for invalid progress or a database failure", async () => {
    await expect(listJobActivity(fixture([{ ...row, progress: 101 }], []).auth)).rejects.toThrow();
    await expect(listJobActivity(fixture([], [], [], true).auth)).rejects.toThrow();
  });
  it("returns an honest empty state without querying arbitrary project data", async () => {
    const f = fixture([], []);
    expect(await listJobActivity(f.auth)).toEqual({ ownerId: owner, active: [], recent: [] });
    expect(f.client.from).toHaveBeenCalledTimes(2);
  });
  it("uses the later completion observation when the two reads straddle completion", async () => {
    const f = fixture([row], [{ ...row, state: "succeeded", progress: 100, finished_at: when }]);
    const result = await listJobActivity(f.auth);
    expect(result.active).toEqual([]);
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0]).toMatchObject({ id: jobId, state: "succeeded", progress: 100 });
  });
  it("retains a newly queued request first observed by the second read", async () => {
    const result = await listJobActivity(fixture([], [{ ...row, state: "queued" }]).auth);
    expect(result.active[0]).toMatchObject({ id: jobId, state: "queued" });
    expect(result.recent).toEqual([]);
  });
  it("keeps unresolved requests active and finished partial results recent", async () => {
    const result = await listJobActivity(
      fixture([{ ...row, state: "needs_reconciliation" }], [{ ...row, id: other, state: "partial", finished_at: when }])
        .auth,
    );
    expect(result.active[0]?.state).toBe("needs_reconciliation");
    expect(result.recent[0]?.state).toBe("partial");
  });
});
