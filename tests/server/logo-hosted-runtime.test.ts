import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isHostedLogoRuntime } from "../../src/server/logo-creation/hosted-runtime";
import { isLocalLogoRuntime } from "../../src/server/logo-creation/local-runtime";
import { readLogoCapabilities } from "../../src/server/data/logo-capabilities";
import { createLogoJobService, LogoAdmissionUncertainError } from "../../src/server/data/logo-jobs";
import type { AuthenticatedContext } from "../../src/server/auth/context";

const hosted = { FLUID_HOSTED_LOGO_ENABLED: "true", NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
  VERCEL_PROJECT_ID: "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt", APP_ORIGIN: "https://fluid-platform-preview.vercel.app" };
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const expected = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 1,
  stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
const intent = { requestKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", quoteId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", acceptedMaxCostMicrousd: 100, expected };
const unavailableOperations = Object.fromEntries(["concept", "refine", "vectorize", "directions", "export"].map(op => [`identity.logo_${op}`, { status: "unavailable" }]));
function enable() { for (const [key, value] of Object.entries(hosted)) vi.stubEnv(key, value); }
function authWith(rpc: unknown) { return { userId: owner, client: { rpc } } as unknown as AuthenticatedContext; }
afterEach(() => vi.unstubAllEnvs());

describe("hosted Logo account routing", () => {
  it("selects only the opted-in canonical production web project", () => {
    expect(isHostedLogoRuntime(hosted)).toBe(true);
    expect(isHostedLogoRuntime({ ...hosted, VERCEL_TARGET_ENV: "production" })).toBe(true);
    expect(isLocalLogoRuntime(hosted)).toBe(false);
  });
  it.each([
    ["FLUID_HOSTED_LOGO_ENABLED", undefined], ["FLUID_HOSTED_LOGO_ENABLED", "TRUE"],
    ["NODE_ENV", "test"], ["NODE_ENV", "development"], ["VERCEL", undefined], ["VERCEL", "0"],
    ["VERCEL_ENV", "preview"], ["VERCEL_ENV", undefined], ["VERCEL_TARGET_ENV", "preview"],
    ["VERCEL_PROJECT_ID", "prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx"], ["VERCEL_PROJECT_ID", undefined],
    ["APP_ORIGIN", "https://unrelated.vercel.app"], ["APP_ORIGIN", "https://fluid-platform-preview.vercel.app/"],
    ["APP_ORIGIN", "http://127.0.0.1:3106"], ["FLUID_RUNTIME", "local"], ["FLUID_LOCAL_LOGO_ENABLED", "true"],
    ["FLUID_LOCAL_PROTOTYPE", "true"],
  ])("rejects a missing or conflicting runtime %s=%s", (key, value) => {
    expect(isHostedLogoRuntime({ ...hosted, [key!]: value })).toBe(false);
  });
  it("uses the existing authenticated capability boundary without a client owner parameter", async () => {
    enable();
    const rpc = vi.fn().mockResolvedValue({ data: { ownerId: owner, projectId: project, observedAt: "2026-10-19T00:00:00.000Z", operations: unavailableOperations }, error: null });
    await readLogoCapabilities(authWith(rpc), project);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("local_logo_operation", { p_project_id: project, p_kind: "capabilities", p_input: null });
  });
  it("rejects capability data for another account", async () => {
    enable();
    const rpc = vi.fn().mockResolvedValue({ data: { ownerId: project, projectId: project, observedAt: "2026-10-19T00:00:00.000Z", operations: unavailableOperations }, error: null });
    await expect(readLogoCapabilities(authWith(rpc), project)).rejects.toMatchObject({ code: "not_found" });
  });
  it("retains the exact durable admission intent on a lost acknowledgment", async () => {
    enable();
    const rpc = vi.fn().mockRejectedValue(new Error("synthetic lost acknowledgement"));
    const error = await createLogoJobService().admitLogoOperation(authWith(rpc), project, intent).catch(value => value);
    expect(error).toBeInstanceOf(LogoAdmissionUncertainError);
    expect(error.recovery).toEqual({ projectId: project, input: intent });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("local_logo_operation", { p_project_id: project, p_kind: "admit", p_input: intent });
  });
  it("keeps history/reconciliation on the ordinary owner RPC without admitting work", async () => {
    enable();
    const rpc = vi.fn().mockResolvedValue({ data: { status: "not_found" }, error: null });
    await createLogoJobService().readLogoRequest(authWith(rpc), project, intent.requestKey);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("read_logo_request", { p_project_id: project, p_request_key: intent.requestKey });
  });
  it("leaves production opt-out and previews on ordinary admission", async () => {
    enable(); vi.stubEnv("VERCEL_ENV", "preview");
    const rpc = vi.fn().mockRejectedValue(new Error("synthetic unavailable"));
    await createLogoJobService().admitLogoOperation(authWith(rpc), project, intent).catch(() => {});
    expect(rpc).toHaveBeenCalledExactlyOnceWith("admit_logo_operation", { p_project_id: project, p_input: intent });
  });
});
