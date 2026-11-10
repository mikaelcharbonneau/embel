import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
import { POST as select } from "../../src/app/api/projects/[projectId]/identity/selection/route";
import { POST as refine } from "../../src/app/api/projects/[projectId]/identity/refinements/route";
import { createTestDatabase, OWNER_B, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";
import { identityDalAuth, seedIdentityRoot } from "../database/identity-system-database";

describe("Identity guarded mutation APIs through actual owned local SQL", () => {
  let db: TestDatabase, project: string, f: Awaited<ReturnType<typeof seedIdentityRoot>>;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv("APP_ORIGIN", "https://fluid.example");
    await resetFixture(db);
    project = (await seedProject(db)).id;
    f = await seedIdentityRoot(db, project);
    mocks.auth.mockResolvedValue(identityDalAuth(db));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it.each(["selection", "refinement"])(
    "returns503 for owned %s and404 for a foreign owner without mutation",
    async (kind) => {
      const common = {
        expectedProjectRevision: f.input.projectRevision,
        expectedReferenceRevision: f.input.referenceSnapshot.referenceRevision,
        expectedPreferencesRevision: 0,
        expectedIdentityRevision: 0,
        acceptEarlierBasis: false,
      };
      const body =
        kind === "selection"
          ? { ...common, systemVersionId: f.system.id }
          : {
              ...common,
              baseSystemVersionId: f.system.id,
              component: "colors",
              input: { swatches: [{ key: "primary", name: "New", hex: "#ABCDEF" }], usageNotes: "" },
              idempotencyKey: "unavailable-api-test-0001",
            };
      const request = () =>
        new Request(`https://fluid.example/api/projects/${project}/identity/${kind}`, {
          method: "POST",
          headers: { origin: "https://fluid.example", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const handler = kind === "selection" ? select : refine,
        params = { params: Promise.resolve({ projectId: project }) };
      const response = await handler(request(), params);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).not.toContain("identity_trusted_transaction");
      mocks.auth.mockResolvedValue(identityDalAuth(db, OWNER_B));
      expect((await handler(request(), params)).status).toBe(404);
      for (const table of ["identity_sessions", "identity_selections", "identity_component_changes", "asset_usages"])
        expect((await db.query(`select count(*)::int count from public.${table}`)).rows[0]).toEqual({ count: 0 });
    },
  );
});
