import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { logoOperationBoundary } from "@/server/logo-creation/operation-routing";
import { readLogoCapabilities } from "@/server/data/logo-capabilities";
import { createLogoJobService, LogoAdmissionUncertainError } from "@/server/data/logo-jobs";
import type { AuthenticatedContext } from "@/server/auth/context";

const env = { EMBEL_MANAGED_LOGO_ENABLED: "true", EMBEL_ACCOUNT_ENROLLMENT_ENABLED: "true", FLUID_HOSTED_LOGO_ENABLED: "true",
  NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt", APP_ORIGIN: "https://www.embel.xyz" };
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const expected = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 1,
  stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
const intent = { requestKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", quoteId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", acceptedMaxCostMicrousd: 100, expected };
function enable() { for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value); }
function auth(rpc: unknown, ownerId = owner) { return { userId: ownerId, client: { rpc } } as unknown as AuthenticatedContext; }
afterEach(() => vi.unstubAllEnvs());

it("keeps legacy routing by default and selects the fixed managed owned RPC only for explicitly enabled managed release", () => {
  expect(logoOperationBoundary({ ...env, EMBEL_MANAGED_LOGO_ENABLED: undefined })).toBe("local_logo_operation");
  expect(logoOperationBoundary(env)).toBe("account_logo_operation");
});
it.each([
  ["EMBEL_ACCOUNT_ENROLLMENT_ENABLED", "false"], ["NODE_ENV", "development"], ["VERCEL", undefined],
  ["VERCEL_ENV", "preview"], ["VERCEL_TARGET_ENV", "preview"], ["VERCEL_PROJECT_ID", "foreign"],
  ["APP_ORIGIN", "https://www.embel.xyz/"], ["APP_ORIGIN", "http://127.0.0.1:3105"],
  ["FLUID_LOCAL_LOGO_ENABLED", "true"], ["EMBEL_DEVELOPMENT_ENABLED", "true"],
])("rejects conflicting managed configuration %s before any fallback", (key, value) => {
  expect(() => logoOperationBoundary({ ...env, [key!]: value })).toThrow();
});
it("reads capabilities using the caller's authenticated client for either enrolled account", async () => {
  enable();
  const operations = Object.fromEntries(["concept", "refine", "vectorize", "directions", "export"].map(operation => [`identity.logo_${operation}`, { status: "unavailable" }]));
  for (const ownerId of [owner, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]) {
    const rpc = vi.fn().mockResolvedValue({ data: { ownerId, projectId: project, observedAt: "2026-10-27T00:00:00Z", operations }, error: null });
    expect((await readLogoCapabilities(auth(rpc, ownerId), project)).ownerId).toBe(ownerId);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("account_logo_operation", { p_project_id: project, p_kind: "capabilities", p_input: null });
  }
});
it("preserves an uncertain admission's exact intent and never falls back to the single-owner wrapper", async () => {
  enable(); const rpc = vi.fn().mockRejectedValue(new Error("synthetic uncertain outcome"));
  const error = await createLogoJobService().admitLogoOperation(auth(rpc), project, intent).catch(value => value);
  expect(error).toBeInstanceOf(LogoAdmissionUncertainError); expect(error.recovery).toEqual({ projectId: project, input: intent });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("account_logo_operation", { p_project_id: project, p_kind: "admit", p_input: intent });
});
it("keeps owned history readable and performs no admission when the managed runtime is unavailable", async () => {
  enable(); vi.stubEnv("VERCEL_ENV", "preview"); const rpc = vi.fn().mockResolvedValue({ data: { status: "not_found" }, error: null });
  await expect(readLogoCapabilities(auth(rpc), project)).rejects.toMatchObject({ code: "integration_unavailable" });
  expect(rpc).not.toHaveBeenCalled();
  await createLogoJobService().readLogoRequest(auth(rpc), project, intent.requestKey);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("read_logo_request", { p_project_id: project, p_request_key: intent.requestKey });
});

it("does not classify a proven configuration failure as an uncertain admission", async () => {
  enable(); vi.stubEnv("VERCEL_ENV", "preview"); const rpc = vi.fn();
  const error = await createLogoJobService().admitLogoOperation(auth(rpc), project, intent).catch(value => value);
  expect(error).toMatchObject({ code: "integration_unavailable" }); expect(error).not.toBeInstanceOf(LogoAdmissionUncertainError);
  expect(rpc).not.toHaveBeenCalled();
});
