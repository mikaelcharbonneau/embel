import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isLocalLogoRuntime } from "../../src/server/logo-creation/local-runtime";
import { readLogoCapabilities } from "../../src/server/data/logo-capabilities";
import { createLogoJobService, LogoAdmissionUncertainError } from "../../src/server/data/logo-jobs";
import type { AuthenticatedContext } from "../../src/server/auth/context";

const environment = { FLUID_LOCAL_LOGO_ENABLED: "true", FLUID_RUNTIME: "local", NODE_ENV: "development", APP_ORIGIN: "http://127.0.0.1:3105" };
afterEach(() => vi.unstubAllEnvs());
describe("explicit local logo account routing", () => {
  it("permits only the two explicit local runtime origins and rejects hosted markers", () => {
    expect(isLocalLogoRuntime(environment)).toBe(true);
    expect(isLocalLogoRuntime({ ...environment, NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:3106" })).toBe(true);
    expect(isLocalLogoRuntime({ ...environment, VERCEL_PROJECT_ID: "public-project-link" })).toBe(true);
    for (const override of [{ FLUID_LOCAL_LOGO_ENABLED: undefined }, { FLUID_RUNTIME: "hosted" }, { APP_ORIGIN: "https://embel.example" }, { NODE_ENV: "production" }, { VERCEL: "1" }, { VERCEL_ENV: "preview" }])
      expect(isLocalLogoRuntime({ ...environment, ...override })).toBe(false);
  });
  it("uses only the owner-derived local capability RPC when explicitly enabled", async () => {
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const operations = Object.fromEntries(["concept", "refine", "vectorize", "directions", "export"].map(op => [`identity.logo_${op}`, { status: "unavailable" }]));
    const rpc = vi.fn().mockResolvedValue({ data: { ownerId: owner, projectId: project, observedAt: "2026-10-18T00:00:00.000Z", operations }, error: null });
    await readLogoCapabilities({ userId: owner, client: { rpc } } as unknown as AuthenticatedContext, project);
    expect(rpc).toHaveBeenCalledWith("local_logo_operation", { p_project_id: project, p_kind: "capabilities", p_input: null });
  });
  it("routes admission locally while retaining its exact uncertain request", async () => {
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
    const expected = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 1,
      stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
    const intent = { requestKey: id(3), quoteId: id(4), acceptedMaxCostMicrousd: 100, expected };
    const rpc = vi.fn().mockRejectedValue(Error("synthetic lost acknowledgement"));
    const service = createLogoJobService(), auth = { userId: id(1), client: { rpc } } as unknown as AuthenticatedContext;
    const error = await service.admitLogoOperation(auth,id(2),intent).catch(value => value);
    expect(error).toBeInstanceOf(LogoAdmissionUncertainError); expect(error.recovery).toEqual({ projectId: id(2), input: intent });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("local_logo_operation", { p_project_id: id(2), p_kind: "admit", p_input: intent });
  });
});
