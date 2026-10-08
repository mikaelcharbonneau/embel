import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { attachIdeaToProject, promoteStandaloneWorkspace, readIdeaProjectAttachmentRequest, getStandalonePromotionSource, getStandalonePromotionSnapshot } from "@/server/data/home-lifecycle";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ideaContentSchema } from "@/domain/ideas";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", key = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const input = { requestKey: key, ideaId: id, expectedIdeaRevision: 2, projectId: id, expectedProjectRevision: 4 };
const receipt = { ownerId: owner, requestKey: key, association: { id, ideaId: id, ideaRevision: 2, projectId: id, projectRevision: 4, createdAt: "2026-10-07T00:00:00Z" }, source: { content: ideaContentSchema.parse({ title: "Frozen source" }) } };
const outcome = { ownerId: owner, requestKey: key, input, status: "attached", attachment: receipt };
function fixture(value: unknown, code?: string) {
 const rpc = vi.fn().mockResolvedValue({ data: value, error: code ? { code } : null });
 return { rpc, auth: { userId: owner, client: { rpc } } as unknown as AuthenticatedContext };
}
describe("manual lifecycle DAL and exact routes", () => {
 afterEach(() => vi.restoreAllMocks());
 it("rejects path/body mismatch and invented frozen content before RPC", async () => {
  const f = fixture(outcome);
  await expect(attachIdeaToProject(f.auth, key, input)).rejects.toMatchObject({ code: "invalid_input" });
  await expect(attachIdeaToProject(f.auth, id, { ...input, source: receipt.source })).rejects.toMatchObject({ code: "invalid_input" }); expect(f.rpc).not.toHaveBeenCalled();
 });
 it("derives owner from auth and rejects malformed or foreign receipts", async () => {
  const f = fixture(outcome); expect(await attachIdeaToProject(f.auth, id, input)).toEqual(outcome);
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith("attach_idea_to_project", { p_input: input });
  for (const invalid of [null, { ...outcome, ownerId: foreign }, { ...outcome, attachment: { ...receipt, association: { ...receipt.association, projectRevision: 5 } } }]) await expect(attachIdeaToProject(fixture(invalid).auth, id, input)).rejects.toMatchObject({ code: "integration_unavailable" });
 });
 it("rejects substituted request and source reader envelopes", async () => {
  await expect(readIdeaProjectAttachmentRequest(fixture({ status: "committed", receipt: { ...outcome, requestKey: id } }).auth, key)).rejects.toMatchObject({ code: "integration_unavailable" });
  await expect(getStandalonePromotionSource(fixture({ ownerId: owner, projectId: key, source: null }).auth, id)).rejects.toMatchObject({ code: "integration_unavailable" });
 });
 it.each([["40001", "conflict"], ["P0002", "not_found"], ["22023", "invalid_input"], ["PGRST202", "integration_unavailable"], ["42501", "unauthenticated"]])("maps %s without inferring success", async (code, expected) => {
  await expect(attachIdeaToProject(fixture(null, code).auth, id, input)).rejects.toMatchObject({ code: expected });
 });
 it("rejects unsupported Assets and whitespace-ambiguous titles before promotion", async () => {
  const f = fixture(null); const input = { requestKey: key, workspaceId: id, expectedWorkspaceRevision: 3, selection: { tool: "domains", domain: "cedar.com" }, contextSource: null, title: "Cedar" };
  await expect(promoteStandaloneWorkspace(f.auth, { ...input, selection: { tool: "assets" } })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(promoteStandaloneWorkspace(f.auth, { ...input, title: " Cedar " })).rejects.toMatchObject({ code: "invalid_input" }); expect(f.rpc).not.toHaveBeenCalled();
 });
 it("accepts a typed already-attached proof while preserving its original inner key and revision", async () => {
  const attempted = { ...input, requestKey: foreign, expectedProjectRevision: 9 };
  const proof = { ...outcome, requestKey: attempted.requestKey, input: attempted, status: "already_attached" };
  expect(await attachIdeaToProject(fixture(proof).auth, id, attempted)).toEqual(proof);
  expect((await readIdeaProjectAttachmentRequest(fixture({ status: "committed", receipt: proof }).auth, attempted.requestKey))).toEqual({ status: "committed", receipt: proof });
  await expect(attachIdeaToProject(fixture({ ...proof, input: { ...attempted, expectedProjectRevision: 8 } }).auth, id, attempted)).rejects.toMatchObject({ code: "integration_unavailable" });
 });
 it("rejects foreign, mismatched and provider-authored frozen payloads", async () => {
  const source = { id: key, ownerId: owner, workspaceId: id, workspaceRevision: 3, selection: { tool: "domains", domain: "cedar.com" }, payloadHash: "a".repeat(64), contextSource: null, createdAt: "2026-10-07T00:00:00Z" };
  const value = { ownerId: owner, projectId: id, source, snapshot: { workspaceId: id, workspaceRevision: 3, payload: { tool: "domains", data: { version: 1, input: "cedar", extensions: ["com"], candidates: ["cedar.com"] } } } };
  expect(await getStandalonePromotionSnapshot(fixture(value).auth, id)).toEqual(value);
  for (const invalid of [ { ...value, ownerId: foreign }, { ...value, projectId: key }, { ...value, snapshot: { ...value.snapshot, workspaceRevision: 4 } }, { ...value, snapshot: { ...value.snapshot, payload: { tool: "domains", data: { ...value.snapshot.payload.data, availability: "available" } } } } ]) await expect(getStandalonePromotionSnapshot(fixture(invalid).auth, id)).rejects.toMatchObject({ code: "integration_unavailable" });
 });

});
