import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { cancelLogoVectorEdit, readLogoVectorEditRequest } from "../../src/features/logo-vector/server/cancellation";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";
const workspace = syntheticLogoWorkspace();
const command = { method: "saveLogoEdit", body: { requestKey: id(803), expected: workspace.heads, baseVectorRevisionId: id(804), edit: { kind: "text", componentId: "lettering", text: "Retained text" } } };
const proof = { status: "cancelled", ownerId: workspace.ownerId, projectId: workspace.projectId, requestKey: id(803), command };
function fixture(data: unknown = proof, error: unknown = null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const auth = { userId: workspace.ownerId, client: { rpc(name: string, args: Record<string, unknown>) { calls.push({ name, args }); const result = Promise.resolve({ data, error }); return Object.assign(result, { abortSignal: () => result }); } } } as unknown as AuthenticatedContext;
  return { auth, calls };
}
describe("vector cancellation authenticated service", () => {
  it("sends the whole frozen original command through only the bounded cancellation RPC", async () => {
    const f = fixture(); expect(await cancelLogoVectorEdit(f.auth, workspace.projectId, command)).toEqual(proof);
    expect(f.calls).toEqual([{ name: "cancel_logo_vector_edit", args: { p_project_id: workspace.projectId, p_command: command } }]);
    expect(Object.isFrozen(f.calls[0]!.args.p_command)).toBe(true);
  });
  it("keeps not-found read-only but never accepts it as a cancellation acknowledgement", async () => {
    const f = fixture({ status: "not_found" });
    expect(await readLogoVectorEditRequest(f.auth, workspace.projectId, id(803))).toEqual({ status: "not_found" });
    await expect(cancelLogoVectorEdit(f.auth, workspace.projectId, command)).rejects.toMatchObject({ name: "LogoUncertainCommitError" });
  });
  it("rejects foreign scope, mismatched keys and changed-body proof", async () => {
    for (const bad of [{ ...proof, ownerId: id(900) }, { ...proof, projectId: id(901) }, { ...proof, requestKey: id(902) }, { ...proof, command: { ...command, body: { ...command.body, edit: { ...command.body.edit, text: "Different" } } } }]) {
      const f = fixture(bad); await expect(cancelLogoVectorEdit(f.auth, workspace.projectId, command)).rejects.toThrow();
    }
  });
  it("maps conflicts but preserves uncertain delivery and aborts without proving cancellation", async () => {
    const conflict = fixture(null, { code: "PT409" }); await expect(cancelLogoVectorEdit(conflict.auth, workspace.projectId, command)).rejects.toMatchObject({ code: "conflict" });
    const lost = fixture(null, { code: "08006" }); await expect(cancelLogoVectorEdit(lost.auth, workspace.projectId, command)).rejects.toMatchObject({ name: "LogoUncertainCommitError" });
    const stopped = fixture(), controller = new AbortController(); controller.abort(); await expect(cancelLogoVectorEdit(stopped.auth, workspace.projectId, command, controller.signal)).rejects.toThrow(); expect(stopped.calls).toEqual([]);
  });
});
