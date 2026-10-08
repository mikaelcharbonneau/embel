import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { createTestDatabase, resetFixture, asRole, OWNER_A, OWNER_B, HASH, type TestDatabase } from "./local-supabase";
import { contextSnapshotSchema } from "@/domain/projects";
import { ideaContentSchema, type IdeaRecord, type IdeaSourceResponse } from "@/domain/ideas";
import { ideaProjectAttachmentOutcomeSchema, type IdeaProjectAttachmentOutcome, type IdeaProjectAttachmentPage } from "@/domain/idea-project-attachment";
import { createTrademarkDraft } from "@/features/trademark-workspace/domain";
import { standalonePromotionReceiptSchema, type StandalonePromotionReceipt, type StandalonePromotionSource } from "@/domain/standalone-promotion";
import type { StandaloneWorkspaceResponse, StandaloneImportResponse } from "@/domain/standalone-workspaces";
import type { RequestLookup } from "@/domain/attachments";
type FixtureResults = {
 create_idea: IdeaRecord; update_idea: IdeaRecord; attach_idea_to_project: IdeaProjectAttachmentOutcome;
 get_project_idea_attachments: IdeaProjectAttachmentPage; get_project_idea_source: IdeaSourceResponse;
 read_idea_project_attachment_request: RequestLookup<IdeaProjectAttachmentOutcome>;
 save_standalone_workspace: StandaloneWorkspaceResponse; get_standalone_workspace: StandaloneWorkspaceResponse;
 get_standalone_import: StandaloneImportResponse; promote_standalone_workspace: StandalonePromotionReceipt;
 get_standalone_promotion_source: { ownerId: string; projectId: string; source: StandalonePromotionSource | null };
};
const key = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
describe("local Home lifecycle SQL boundaries (synthetic accounts)", () => {
 let db: TestDatabase;
 beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
 beforeEach(async () => resetFixture(db)); afterAll(async () => db?.close());
 const run = <T>(fn: () => Promise<T>, owner = OWNER_A) => asRole(db, "authenticated", owner, fn);
 async function rpc<N extends keyof FixtureResults>(name: N, values: unknown[], owner = OWNER_A): Promise<FixtureResults[N]> { return run(async () => (await db.query<{ result: unknown }>(`select public.${name}(${values.map((_,i)=>`$${i+1}`).join(",")}) as result`, values.map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v))).rows[0]!.result as FixtureResults[N], owner); }
 async function project(owner = OWNER_A, context = contextSnapshotSchema.parse({ description: "Prior brief", selectedName: "Cedar" })) { return run(async () => (await db.query<{ id: string }>("select * from public.create_project('naming_only','Prior brand',$1::jsonb,$2)", [JSON.stringify(context), HASH])).rows[0]!, owner); }
 async function idea(owner = OWNER_A) { return rpc("create_idea", [key(1), ideaContentSchema.parse({ title: "Saved Idea", description: "Frozen first version" })], owner); }
 async function workspace(imports: unknown[] = []) { return (await rpc("save_standalone_workspace", ["domains", 0, key(2), { version: 1, input: "cedar", extensions: ["com"], candidates: ["cedar.com"] }, imports])).workspace!; }
 it("attached Idea remains frozen after later edits and leaves project source/context unchanged", async () => {
  const p = await project(), i = await idea(), input = { requestKey: key(3), ideaId: i.id, expectedIdeaRevision: 1, projectId: p.id, expectedProjectRevision: 1 };
  const result = ideaProjectAttachmentOutcomeSchema.parse(await rpc("attach_idea_to_project", [input]));
  await rpc("update_idea", [i.id, 1, key(4), ideaContentSchema.parse({ title: "Changed", description: "Later version" })]);
  expect(await rpc("attach_idea_to_project", [input])).toEqual(result);
  expect((await rpc("get_project_idea_attachments", [p.id, null, 20])).items[0]!.source.content.description).toBe("Frozen first version");
  expect((await rpc("get_project_idea_source", [p.id])).source).toBeNull();
  expect((await db.query("select current_revision from public.projects where id=$1", [p.id])).rows).toEqual([{ current_revision: 1 }]);
  await expect(rpc("attach_idea_to_project", [{ ...input, expectedIdeaRevision: 2 }])).rejects.toMatchObject({ code: "PT409" });
  expect(await rpc("read_idea_project_attachment_request", [key(3)])).toEqual({ status: "committed", receipt: result });
  expect(await rpc("read_idea_project_attachment_request", [key(3)], OWNER_B)).toEqual({ status: "not_found" });
 });
 it("rejects foreign targets, stale revisions, forged content, anonymous and raw writes", async () => {
  const p = await project(OWNER_B), i = await idea(), input = { requestKey: key(3), ideaId: i.id, expectedIdeaRevision: 1, projectId: p.id, expectedProjectRevision: 1 };
  await expect(rpc("attach_idea_to_project", [input])).rejects.toMatchObject({ code: "P0002" });
  const own = await project();
  await expect(rpc("attach_idea_to_project", [{ ...input, projectId: own.id, expectedProjectRevision: 2 }])).rejects.toMatchObject({ code: "PT409" });
  await expect(rpc("attach_idea_to_project", [{ ...input, projectId: own.id, source: {} }])).rejects.toMatchObject({ code: "22023" });
  await expect(asRole(db, "anon", null, () => db.query("select public.attach_idea_to_project('{}'::jsonb)"))).rejects.toMatchObject({ code: "42501" });
  await expect(run(() => db.query("delete from public.idea_project_attachments"))).rejects.toMatchObject({ code: "42501" });
 });
 it("promotion replay returns one brand with the same immutable source and imported conversation", async () => {
  const context = contextSnapshotSchema.parse({ description: "Known description", selectedName: "Cedar", intake: { namingNotes: "Keep these notes", conversation: [{ id: "first", kind: "user_message", text: "My exact prompt", createdAt: "2026-10-07T00:00:00Z" }] } });
  const p = await project(OWNER_A, context), imported = (await rpc("get_standalone_import", [p.id])).source;
  const selection = { projectId: p.id, projectRevision: 1, selectionId: null }; const w = await workspace([selection]);
  const input = { requestKey: key(3), workspaceId: w.id, expectedWorkspaceRevision: 1, selection: { tool: "domains", domain: "cedar.com" }, contextSource: selection, title: "Promoted Cedar" };
  const receipt = standalonePromotionReceiptSchema.parse(await rpc("promote_standalone_workspace", [input]));
  expect(receipt.project.context).toEqual(context); expect(receipt.source.contextSource).toEqual(imported);
  await rpc("save_standalone_workspace", ["domains", 1, key(4), { version: 1, input: "elm", extensions: ["com"], candidates: ["elm.com"] }, []]);
  expect(await rpc("promote_standalone_workspace", [input])).toEqual(receipt);
  const frozen = await run(async () => (await db.query<{ value: { source: unknown; snapshot: { workspaceId: string; workspaceRevision: number; payload: { tool: string; data: unknown } } } }>("select public.get_standalone_promotion_snapshot($1) as value", [receipt.project.id])).rows[0]!.value);
  expect(frozen.source).toEqual(receipt.source);
  expect(frozen.snapshot).toEqual({ workspaceId: w.id, workspaceRevision: 1, payload: { tool: "domains", data: { version: 1, input: "cedar", extensions: ["com"], candidates: ["cedar.com"] } } });
  await expect(run(() => db.query("select public.get_standalone_promotion_snapshot($1)", [receipt.project.id]), OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  expect((await rpc("get_standalone_promotion_source", [receipt.project.id])).source).toEqual(receipt.source);
  expect((await db.query("select count(*)::int total from public.standalone_promotions")).rows).toEqual([{ total: 1 }]);
  await expect(rpc("promote_standalone_workspace", [{ ...input, title: "Changed" }])).rejects.toMatchObject({ code: "PT409" });
 });
 it("rejects unrecorded contexts, missing candidates, assets, foreign sources and rolls back failed promotion", async () => {
  const p = await project(), w = await workspace(); const input = { requestKey: key(3), workspaceId: w.id, expectedWorkspaceRevision: 1, selection: { tool: "domains", domain: "cedar.com" }, contextSource: null, title: "Cedar" };
  await expect(rpc("promote_standalone_workspace", [{ ...input, contextSource: { projectId: p.id, projectRevision: 1, selectionId: null } }])).rejects.toMatchObject({ code: "P0002" });
  await expect(rpc("promote_standalone_workspace", [{ ...input, selection: { tool: "domains", domain: "missing.com" } }])).rejects.toMatchObject({ code: "P0002" });
  await expect(rpc("promote_standalone_workspace", [{ ...input, selection: { tool: "assets" } }])).rejects.toMatchObject({ code: "22023" });
  await expect(rpc("promote_standalone_workspace", [input], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  await db.exec("create function public.reject_fixture_promotion() returns trigger language plpgsql as $$ begin raise exception 'fixture failure' using errcode='23514'; end $$; create trigger reject_fixture_promotion before insert on public.standalone_promotions for each row execute function public.reject_fixture_promotion()");
  try { await expect(rpc("promote_standalone_workspace", [input])).rejects.toMatchObject({ code: "23514" }); expect((await db.query("select count(*)::int total from public.projects")).rows).toEqual([{ total: 1 }]); }
  finally { await db.exec("drop trigger reject_fixture_promotion on public.standalone_promotions; drop function public.reject_fixture_promotion()"); }
 });
 it("promotes saved handle and trademark inputs without upgrading declarations into evidence", async () => {
  const handles = { version: 1, bundles: [{ id: "bundle", title: "Cedar handles", list: "User list", savedAt: "2026-10-07T00:00:00Z", source: { id: "manual", name: "Cedar", origin: "manual", projectId: null, projectTitle: null }, entries: [{ platform: "instagram", handle: "cedar", favorite: true, selected: false, accountCreated: { declaredAt: "2026-10-07T00:00:00Z", url: "https://instagram.com/cedar" }, evidence: [] }] }] };
  const h = (await rpc("save_standalone_workspace", ["handles", 0, key(11), handles, []])).workspace!;
  const hp = standalonePromotionReceiptSchema.parse(await rpc("promote_standalone_workspace", [{ requestKey: key(12), workspaceId: h.id, expectedWorkspaceRevision: 1, selection: { tool: "handles", bundleId: "bundle" }, contextSource: null, title: "Cedar" }]));
  expect(hp.project.context.selectedName).toBe("Cedar"); expect(hp.project.context.reformulationConfirmed).toBe(false); expect(hp.source.selection).toEqual({ tool: "handles", bundleId: "bundle" });
  const trademark = { ...createTrademarkDraft("Cedar mark"), goodsServices: "User supplied service notes", userNotes: "Keep this qualification", reviewedContent: null };
  const t = (await rpc("save_standalone_workspace", ["trademarks", 0, key(13), trademark, []])).workspace!;
  const tp = standalonePromotionReceiptSchema.parse(await rpc("promote_standalone_workspace", [{ requestKey: key(14), workspaceId: t.id, expectedWorkspaceRevision: 1, selection: { tool: "trademarks" }, contextSource: null, title: "Cedar mark" }]));
  expect(tp.project.context.description).toBe("User supplied service notes\n\nKeep this qualification"); expect(tp.project.context.selectedName).toBe("Cedar mark"); expect(tp.project.context.intake.positioningReviewedAt).toBeNull();
  expect((await rpc("get_standalone_workspace", ["handles"])).workspace).toEqual(h); expect((await rpc("get_standalone_workspace", ["trademarks"])).workspace).toEqual(t);
 });
 it("paginates frozen attachments and preserves their source when scope expands", async () => {
  const p = await project();
  for (let index = 1; index <= 3; index++) {
   const i = await rpc("create_idea", [key(100 + index), ideaContentSchema.parse({ title: `Idea ${index}` })]);
   await rpc("attach_idea_to_project", [{ requestKey: key(200 + index), ideaId: i.id, expectedIdeaRevision: 1, projectId: p.id, expectedProjectRevision: 1 }]);
  }
  const first = await rpc("get_project_idea_attachments", [p.id, null, 2]), second = await rpc("get_project_idea_attachments", [p.id, first.nextCursor, 2]);
  expect(first.items).toHaveLength(2); expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
  await expect(rpc("get_project_idea_attachments", [p.id, null, 20], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  await run(() => db.query("select public.expand_project_scope($1,1)", [p.id]));
  expect(await rpc("get_project_idea_attachments", [p.id, null, 2])).toEqual(first);
  expect((await db.query("select current_revision,scope from public.projects where id=$1", [p.id])).rows).toEqual([{ current_revision: 2, scope: "complete_brand" }]);
  expect((await db.query("select context,input_hash from public.project_revisions where project_id=$1 order by revision", [p.id])).rows[0]).toEqual((await db.query("select context,input_hash from public.project_revisions where project_id=$1 order by revision", [p.id])).rows[1]);
  await expect(db.query("update public.idea_project_attachments set receipt='{}'::jsonb")).rejects.toMatchObject({ code: "55000" });
  expect((await run(() => db.query("select * from public.idea_project_attachments"), OWNER_B)).rows).toEqual([]);
 });

 it("records a new exact-key already-attached outcome without rewriting the original association revision", async () => {
  const p = await project(), i = await idea(), input = { requestKey: key(310), ideaId: i.id, expectedIdeaRevision: 1, projectId: p.id, expectedProjectRevision: 1 };
  const first = await rpc("attach_idea_to_project", [input]); expect(first).toMatchObject({ status: "attached", input });
  await run(() => db.query("select public.expand_project_scope($1,1)", [p.id]));
  const again = { ...input, requestKey: key(311), expectedProjectRevision: 2 };
  const second = await rpc("attach_idea_to_project", [again]);
  expect(second).toMatchObject({ ownerId: OWNER_A, requestKey: again.requestKey, status: "already_attached", input: again });
  expect(second.attachment).toEqual(first.attachment);
  expect(second.attachment.association.projectRevision).toBe(1); expect(second.attachment.requestKey).toBe(input.requestKey);
  expect(await rpc("read_idea_project_attachment_request", [again.requestKey])).toEqual({ status: "committed", receipt: second });
  expect(await rpc("attach_idea_to_project", [again])).toEqual(second);
  await expect(rpc("attach_idea_to_project", [{ ...again, expectedProjectRevision: 1 }])).rejects.toMatchObject({ code: "PT409" });
  expect((await db.query("select count(*)::int total from public.idea_project_attachments")).rows).toEqual([{ total: 1 }]);
  expect((await db.query("select count(*)::int total from public.idea_project_attachment_requests")).rows).toEqual([{ total: 2 }]);
  expect((await rpc("get_project_idea_attachments", [p.id, null, 20])).items).toEqual([first.attachment]);
 });

 it("independent request keys converge on one immutable association and ledger failures roll back atomically", async () => {
  const p = await project(), i = await idea(), input = { requestKey: key(410), ideaId: i.id, expectedIdeaRevision: 1, projectId: p.id, expectedProjectRevision: 1 };
  await db.exec("create function public.reject_fixture_attachment_request() returns trigger language plpgsql as $$ begin raise exception 'fixture ledger failure' using errcode='23514'; end $$; create trigger reject_fixture_attachment_request before insert on public.idea_project_attachment_requests for each row execute function public.reject_fixture_attachment_request()");
  try {
   await expect(rpc("attach_idea_to_project", [input])).rejects.toMatchObject({ code: "23514" });
   expect((await db.query("select count(*)::int total from public.idea_project_attachments")).rows).toEqual([{ total: 0 }]);
   expect(await rpc("read_idea_project_attachment_request", [input.requestKey])).toEqual({ status: "not_found" });
  } finally { await db.exec("drop trigger reject_fixture_attachment_request on public.idea_project_attachment_requests; drop function public.reject_fixture_attachment_request()"); }
  // PGlite queues both statements locally; the production function additionally
  // takes the same pair lock for different keys and has a unique tuple constraint.
  const pair = await run(() => Promise.all([input, { ...input, requestKey: key(411) }].map(async attempt => (await db.query<{ result: unknown }>("select public.attach_idea_to_project($1::jsonb) as result", [JSON.stringify(attempt)])).rows[0]!.result)));
  const outcomes = pair.map(value => ideaProjectAttachmentOutcomeSchema.parse(value));
  expect(outcomes.map(value => value.status).sort()).toEqual(["already_attached", "attached"]);
  expect(outcomes[0]!.attachment).toEqual(outcomes[1]!.attachment);
  expect((await db.query("select count(*)::int total from public.idea_project_attachments")).rows).toEqual([{ total: 1 }]);
  await expect(db.query("update public.idea_project_attachment_requests set receipt='{}'::jsonb")).rejects.toMatchObject({ code: "55000" });
  expect((await run(() => db.query("select * from public.idea_project_attachment_requests"), OWNER_B)).rows).toEqual([]);
 });

});
