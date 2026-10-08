import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { initializeExistingBrandLogo } from "../../src/server/data/existing-brand-logo";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";
import type { AuthenticatedContext } from "../../src/server/auth/context";
const workspace = syntheticLogoWorkspace(), brief = { name: "Exact name", activity: "Studio", audience: "Founders", personality: "Calm", logoTypes: ["wordmark"] };
const input = { requestKey: id(900), expected: workspace.heads, brief };
function receipt() { return { ownerId: workspace.ownerId, projectId: workspace.projectId, requestKey: input.requestKey, workspace: { ...workspace, heads: { ...workspace.heads, workspaceRevision: 1, stageRevisions: { ...workspace.heads.stageRevisions, brief_references: 1 } }, stages: { ...workspace.stages, brief_references: { stage: "brief_references", id: id(901), revision: 1 } } },
  revision: { version: 2, id: id(901), ownerId: workspace.ownerId, projectId: workspace.projectId, stage: "brief_references", revision: 1, parentRevisionId: null, inputRevisions: [], inputHash: "a".repeat(64), createdAt: "2026-10-07T00:00:00Z", payload: { ...brief, referenceSnapshotId: id(902), sourceProjectRevision: 1 } } }; }
const auth = (rpc: (...args: unknown[]) => unknown) => ({ userId: workspace.ownerId, client: { rpc } }) as unknown as AuthenticatedContext;
describe("existing-brand initialization DAL", () => {
  it("uses only the fixed authenticated RPC and verifies the exact first-stage receipt", async () => {
    const rpc = vi.fn(async () => ({ data: receipt(), error: null }));
    expect(await initializeExistingBrandLogo(auth(rpc), workspace.projectId, input)).toEqual(receipt());
    expect(rpc).toHaveBeenCalledExactlyOnceWith("initialize_existing_brand_logo", { p_project_id: workspace.projectId, p_input: input });
  });
  it("rejects client owner claims before any call", async () => {
    const rpc = vi.fn(); await expect(initializeExistingBrandLogo(auth(rpc), workspace.projectId, { ...input, ownerId: id(999) })).rejects.toMatchObject({ code: "invalid_input" }); expect(rpc).not.toHaveBeenCalled();
  });
  it.each(["owner", "source", "brief", "head"])("keeps a malformed %s response uncertain rather than confirming initialization", async field => {
    const value = receipt();
    if (field === "owner") value.ownerId = id(999);
    if (field === "source") value.revision.payload.sourceProjectRevision = 2;
    if (field === "brief") value.revision.payload.name = "Altered name";
    if (field === "head") value.workspace.heads.projectRevision = 2;
    const rpc = vi.fn(async () => ({ data: value, error: null }));
    await expect(initializeExistingBrandLogo(auth(rpc), workspace.projectId, input)).rejects.toMatchObject({ name: "LogoUncertainCommitError", recovery: { projectId: workspace.projectId, input: { method: "saveLogoBrief", body: input } } });
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("retains the original command after lost acknowledgement and does not retry", async () => {
    const rpc = vi.fn(async () => { throw new Error("Connection lost"); });
    await expect(initializeExistingBrandLogo(auth(rpc), workspace.projectId, input)).rejects.toMatchObject({ name: "LogoUncertainCommitError", recovery: { projectId: workspace.projectId, input: { method: "saveLogoBrief", body: input } } }); expect(rpc).toHaveBeenCalledOnce();
  });
  it("returns typed rejection only for a committed exact-body SQL rejection record", async () => {
    const rpc = vi.fn(async () => ({ data: { kind: "logo_initialization_rejected", rejection: { status: "rejected", ownerId: workspace.ownerId, projectId: workspace.projectId, requestKey: input.requestKey, input } }, error: null }));
    await expect(initializeExistingBrandLogo(auth(rpc), workspace.projectId, input)).rejects.toMatchObject({ name: "LogoInitializationRejectedError", rejection: { status: "rejected", ownerId: workspace.ownerId, projectId: workspace.projectId, requestKey: input.requestKey, inputHash: expect.stringMatching(/^[0-9a-f]{64}$/) } });
  });
  it("maps a known owner-scoped CAS rejection to conflict without uncertainty", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "PT409" } })); await expect(initializeExistingBrandLogo(auth(rpc), workspace.projectId, input)).rejects.toMatchObject({ name: "ApiError", code: "conflict" });
  });
});
