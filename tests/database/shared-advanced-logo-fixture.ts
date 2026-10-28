import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSharedStorageFixture, OWNER_A } from "./shared-storage-fixture";
import { productionStorageFixture, vectorCapability, exportCapability } from "./logo-production-storage-fixture";
import { proposalPolicy } from "../server/logo-vector-proposal-fixtures";
import { logoDirectionsApiPolicySchema, logoCostQuoteSchema, logoDispatchReceiptSchema } from "../../src/domain/logo-jobs";
import { uncappedLogoVectorProposalTextPolicySchema } from "../../src/domain/logo-vector-proposal-jobs";
import { proposalFixture } from "../features/logo-vector/proposal-fixtures";
import { buildLogoVectorProposalContext } from "../../src/features/logo-vector/server/proposal-context";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { installSqlSubscriptionFixture, bindSqlSubscriptionFixture, approvedSqlDirectionFixture } from "./logo-directions-subscription-fixture";

/** Disposable SQL/provider-schema fixture only. Legacy source artwork/receipts,
 * Auth claims/sessions and Storage records are explicitly synthetic. There is no
 * live Auth/Vault/provider connection, role provisioning or paid generation. */
export async function createSharedAdvancedLogoFixture() {
 const f = await createSharedStorageFixture(), { db } = f;
 try {
  await db.exec(await readFile(new URL("../../supabase/candidates/shared_logo_advanced.sql", import.meta.url), "utf8"));
  await db.query("insert into public.usage_accounts(owner_id,limit_microusd) values($1,0) on conflict(owner_id) do nothing", [OWNER_A]);
  const legacy = await productionStorageFixture(db);
  await db.exec(await readFile(new URL("../../supabase/candidates/shared_logo_http.sql", import.meta.url), "utf8"));
  const webRole = "embel_shared_http_logo_advanced_fixture";
  await db.exec(`create role authenticator login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;grant authenticated to authenticator;
   create role ${webRole} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;grant usage on schema public to ${webRole};
   grant execute on function public.shared_logo_http_principal(),public.execute_shared_logo_request(text,text,jsonb,jsonb) to ${webRole};
   insert into fluid_private.shared_logo_http_principals(lane,role_name,role_oid,enabled) select 'logo',rolname,oid,true from pg_roles where rolname='${webRole}';`);
  const { maximumCostMicrousd: _oldCeiling, ...proposalBase } = proposalPolicy(); void _oldCeiling;
  const textPolicy = uncappedLogoVectorProposalTextPolicySchema.parse({ ...proposalBase, version: 2, spendControl: "uncapped", adapterVersion: "logo-vector-propose-api-uncapped-v2" });
  const { schemaVersion: _schema, ...directionBase } = textPolicy; void _schema;
  const apiPolicy = logoDirectionsApiPolicySchema.parse({ ...directionBase, version: 1, handlerVersion: "logo-directions-api-v1", adapterVersion: "logo-directions-openai-v1" });
  const directionsCapability = { operation: "identity.logo_directions", policyIdentity: "6".repeat(64), handlerVersion: "logo-directions-api-v1", provider: "openai", model: "gpt-6.1-sol", engine: null, spendControl: "uncapped", apiPolicy };
  const proposalCapability = { operation: "identity.logo_vector_propose", policyIdentity: "7".repeat(64), handlerVersion: "logo-vector-propose-v1", provider: "openai", model: "gpt-6.1-sol", engine: null, spendControl: "uncapped", textPolicy };
  for (const capability of [vectorCapability, exportCapability, directionsCapability, proposalCapability]) await db.query("insert into fluid_private.shared_worker_policies values($1,$2,$3,$4)", [f.slotId, capability.operation, capability.policyIdentity, capability]);
  async function runtimeReady(manifest?: unknown[]) {
   const actual = manifest ?? (await db.query<{ policy: unknown }>("select policy from fluid_private.shared_worker_policies where slot_id=$1 order by operation", [f.slotId])).rows.map(row => row.policy);
   return (await f.action(null, "runtime_ready", [actual])).result;
  }
  async function rawJob(id: string) { return (await db.query<{ id: string; owner_id: string; project_id: string; state: string; lease_token: string | null; input: Record<string, unknown>; plan_manifest: unknown }>("select * from public.jobs where id=$1", [id])).rows[0]!; }
  async function logoWeb(owner: string, action: string, project: string, intent: unknown, evidence: unknown = null) {
   const capability = await f.owner(owner, async () => {
    await db.exec("set session authorization postgres;set session authorization authenticator;set role authenticated");
    return (await db.query<{ value: { token: string } }>("select public.issue_shared_logo_request($1,$2) value", [action, [project, intent]])).rows[0]!.value;
   });
   return f.owner(owner, async () => {
    await db.exec(`set session authorization postgres;set session authorization ${webRole}`);
    return (await db.query<{ value: unknown }>("select public.execute_shared_logo_request($1,$2,$3,$4) value", [capability.token, action, [project, intent], evidence])).rows[0]!.value;
   });
  }
  async function admit(project: string, quote: { id: string; expected: unknown }, owner = OWNER_A) {
   const request = { requestKey: randomUUID(), quoteId: quote.id, expected: quote.expected };
   const receipt = await f.owner(owner, async () => logoDispatchReceiptSchema.parse((await db.query<{ value: unknown }>("select public.shared_logo_operation($1,'admit',$2) value", [project, request])).rows[0]!.value));
   return { request, receipt, jobId: receipt.jobIds[0]!, job: await rawJob(receipt.jobIds[0]!) };
  }
  async function cancelLegacy(job: { id: string; leaseToken: string }) {
   await legacy.rpc("request_job_cancel", [job.id]);
   await legacy.connection.query("select public.finish_logo_job($1,$2,'cancelled')", [job.id, job.leaseToken]);
  }
  async function prepareVector() {
   // Historical source creation alone uses its existing capped contract. The
   // new shared vector request is then proved against a zero allowance ledger.
   await db.query("update public.usage_accounts set limit_microusd=5000000 where owner_id=$1", [OWNER_A]);
   const source = await legacy.prepareVector(); await cancelLegacy(source.job);
   const originalQuote = (await db.query<{ record: { request: unknown } }>("select record from public.logo_cost_quotes where id=$1", [(source.job.input as { quoteId: string }).quoteId])).rows[0]!.record;
   await db.query("update public.usage_accounts set limit_microusd=0 where owner_id=$1", [OWNER_A]);
   const quote = await f.owner(OWNER_A, async () => logoCostQuoteSchema.parse((await db.query<{ value: unknown }>("select public.shared_logo_operation($1,'quote',$2) value", [source.job.projectId, originalQuote.request])).rows[0]!.value));
   return { ...await admit(source.job.projectId, quote), capability: vectorCapability, source, sourceBytes: legacy.blobs };
  }
  async function prepareExport() {
   const source = await legacy.prepareExport(); await cancelLegacy(source.job);
   const previous = (await db.query<{ input: Record<string, unknown> }>("select input from public.logo_operation_requests where receipt->'jobIds' @> $1::jsonb", [JSON.stringify([source.job.id])])).rows[0]!.input;
   const request = { ...previous, requestKey: randomUUID() };
   const receipt = await f.owner(OWNER_A, async () => logoDispatchReceiptSchema.parse((await db.query<{ value: unknown }>("select public.shared_logo_operation($1,'export',$2) value", [source.job.projectId, request])).rows[0]!.value));
   return { request, receipt, jobId: receipt.jobIds[0]!, job: await rawJob(receipt.jobIds[0]!), capability: exportCapability, source, sourceBytes: legacy.blobs };
  }
  async function prepareProposal(owner = OWNER_A) {
   const w = await f.project(owner), source = proposalFixture();
   const brief = (await db.query<{ record: typeof source.brief }>("select record from public.logo_stage_revisions where id=$1", [w.stages.brief_references!.id])).rows[0]!.record;
   source.brief = brief; source.revision.id = randomUUID(); source.revision.ownerId = owner; source.revision.projectId = w.projectId;
   source.revision.inputRevisions = [{ stage: "brief_references", id: brief.id, revision: brief.revision }];
   for (const reference of [source.revision.sourcePreview, source.revision.documentAsset, source.revision.svgAsset]) {
    reference.ownerId = owner; reference.projectId = w.projectId; reference.assetId = randomUUID(); reference.versionId = randomUUID();
   }
   for (const font of source.fonts) {
    font.id = randomUUID(); font.asset.ownerId = owner; font.asset.projectId = w.projectId; font.asset.assetId = randomUUID(); font.asset.versionId = randomUUID(); font.rights.id = randomUUID();
    await db.query("insert into public.logo_font_records(record_id,version_id,owner_id,project_id,record) values($1,$2,$3,$4,$5)", [font.id, font.asset.versionId, owner, w.projectId, font]);
   }
   await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)", [source.revision.id, owner, w.projectId, source.revision]);
   await db.query("select fluid_private.logo_append_stage($1,$2,'vector',$3,$4)", [owner, w.projectId, { vectorRevisionId: source.revision.id, approvalId: null }, source.revision.inputRevisions]);
   const current = await f.owner(owner, async () => logoWorkspaceV2Schema.parse((await db.query<{ value: unknown }>("select public.get_logo_workspace($1) value", [w.projectId])).rows[0]!.value));
   const context = buildLogoVectorProposalContext(source), request = { operation: "propose_vector_edit", expected: current.heads, baseVectorRevisionId: source.revision.id, instruction: "Rotate the symbol", targetComponentIds: source.targetComponentIds };
   const evidence = { version: 1, request, context, baseRevision: source.revision, brief, fonts: source.fonts };
   const quote = logoCostQuoteSchema.parse(await logoWeb(owner, "proposal_quote", w.projectId, request, evidence));
   return { ...await admit(w.projectId, quote, owner), quote, context, source, evidence, workspace: current, capability: proposalCapability };
  }
  let directionsInstalled = false;
  async function prepareDirections() {
   if (!directionsInstalled) { await installSqlSubscriptionFixture(db); await bindSqlSubscriptionFixture(db); directionsInstalled = true; }
   const source = await approvedSqlDirectionFixture(db);
   const quote = await f.owner(OWNER_A, async () => logoCostQuoteSchema.parse((await db.query<{ value: unknown }>("select public.shared_logo_operation($1,'quote',$2) value", [source.w.projectId, source.request])).rows[0]!.value));
   return { ...await admit(source.w.projectId, quote), quote, source, capability: directionsCapability };
  }
  return { ...f, legacy, runtimeReady, rawJob, logoWeb, admitAdvanced: admit, prepareVector, prepareExport, prepareProposal, prepareDirections, directionsCapability, proposalCapability };
 } catch (error) { if (db.isInTransaction()) await db.exec("rollback"); await f.close(); throw error; }
}
export type SharedAdvancedLogoFixture = Awaited<ReturnType<typeof createSharedAdvancedLogoFixture>>;
