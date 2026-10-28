import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedAdvancedLogoFixture, type SharedAdvancedLogoFixture } from "../database/shared-advanced-logo-fixture";
import { OWNER_A, OWNER_B } from "../database/local-supabase";
import { logoCostQuoteSchema, logoGenerationIntentSchema } from "../../src/domain/logo-jobs";

/** Actual disposable SQL authority checks; Auth sessions, artwork, provider and
 * publication metadata in the shared fixture are synthetic. No provider I/O. */
describe("independent original proposal intent authority", () => {
 let f: SharedAdvancedLogoFixture;
 beforeAll(async () => { f = await createSharedAdvancedLogoFixture(); await f.runtimeReady(); }, 90_000);
 afterAll(async () => { await f?.close(); });
 async function rpc(owner: string, name: "read_logo_vector_proposal_request" | "close_logo_vector_proposal_request", project: string, input: unknown) {
  return f.owner(owner, async () => {
   await f.db.exec("set session authorization postgres;set session authorization authenticator;set role authenticated");
   return (await f.db.query<{ value: Record<string, unknown> }>(`select public.${name}($1,$2) value`, [project, input])).rows[0]!.value;
  });
 }
 it("denies cross-account and changed-head bodies without closing the actual admitted request", async () => {
  const p = await f.prepareProposal(), original = logoGenerationIntentSchema.parse(p.request);
  await expect(rpc(OWNER_B, "close_logo_vector_proposal_request", p.job.project_id, p.request)).rejects.toMatchObject({ code: "P0002" });
  await expect(rpc(OWNER_A, "close_logo_vector_proposal_request", p.job.project_id, {
   ...original, expected: { ...original.expected, projectRevision: original.expected.projectRevision + 1 },
  })).rejects.toMatchObject({ code: "PT409" });
  expect((await f.rawJob(p.jobId)).state).toBe("queued");
  expect((await f.db.query("select 1 from fluid_private.shared_logo_proposal_request_closures where project_id=$1", [p.job.project_id])).rows).toHaveLength(0);
  const recovered = await rpc(OWNER_A, "read_logo_vector_proposal_request", p.job.project_id, p.request);
  expect(recovered.input).toEqual(p.request);
 });
 it("closes an unused original quote after its captured heads change, then fences exact late admission", async () => {
  const p = await f.prepareProposal();
  const quote = logoCostQuoteSchema.parse(await f.logoWeb(OWNER_A, "proposal_quote", p.job.project_id, p.evidence.request, p.evidence));
  const input = { requestKey: randomUUID(), quoteId: quote.id, expected: quote.expected };
  await f.db.query("select fluid_private.logo_append_stage($1,$2,'vector',$3,$4)", [OWNER_A, p.job.project_id,
   { vectorRevisionId: p.source.revision.id, approvalId: null }, p.source.revision.inputRevisions]);
  const closed = await rpc(OWNER_A, "close_logo_vector_proposal_request", p.job.project_id, input);
  expect(closed).toEqual({ status: "not_admitted", ownerId: OWNER_A, projectId: p.job.project_id, input });
  const late = await f.owner(OWNER_A, async () => (await f.db.query<{ value: unknown }>("select public.shared_logo_operation($1,'admit',$2) value", [p.job.project_id, input])).rows[0]!.value);
  expect(late).toMatchObject({ kind: "logo_admission_rejected" });
  expect(await rpc(OWNER_A, "close_logo_vector_proposal_request", p.job.project_id, input)).toEqual(closed);
  expect((await f.db.query("select 1 from public.jobs where input->>'requestKey'=$1", [input.requestKey])).rows).toHaveLength(0);
  await expect(f.db.query("update fluid_private.shared_logo_proposal_request_closures set receipt='{}' where request_key=$1", [input.requestKey])).rejects.toBeDefined();
 });
 it("revoked physical sessions cannot write a cancellation or absence witness", async () => {
  const p = await f.prepareProposal();
  await f.db.query("delete from auth.sessions where user_id=$1", [OWNER_A]);
  await expect(rpc(OWNER_A, "close_logo_vector_proposal_request", p.job.project_id, p.request)).rejects.toMatchObject({ code: "42501" });
  expect((await f.rawJob(p.jobId)).state).toBe("queued");
  expect((await f.db.query("select 1 from fluid_private.shared_logo_proposal_request_closures where project_id=$1", [p.job.project_id])).rows).toHaveLength(0);
 });
});
