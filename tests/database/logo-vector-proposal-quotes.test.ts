import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createTestDatabase, resetFixture, type TestDatabase } from './local-supabase';
import { proposalPolicy } from '../server/logo-vector-proposal-fixtures';
const storage = await readFile(new URL('../../supabase/candidates/logo-vector-proposals.sql', import.meta.url), 'utf8');
const quoteSql = await readFile(new URL('../../supabase/candidates/logo-vector-proposal-quotes.sql', import.meta.url), 'utf8').catch(() => '');
let db: TestDatabase;
const changedFunctions = ['fluid_private.logo_policy_descriptor(fluid_private.logo_runtime_policies)','public.report_logo_worker_ready(text,jsonb,integer)','public.quote_logo_operation(uuid,jsonb)'];
let metadataBefore: unknown[], metadataAfter: unknown[], defaultsBefore: unknown[];
const metadata = (database: TestDatabase) => database.query('select oid,proowner,proacl::text,prosecdef,provolatile,proparallel,proconfig,procost,prorows,proargdefaults::text from pg_proc where oid=any($1::regprocedure[]) order by oid',[changedFunctions]);
beforeAll(async () => {
 db = await createTestDatabase({ additionalMigrations: [storage, quoteSql], beforeMigration: async (database, sql) => {
  if (sql !== quoteSql || !quoteSql) return;
  await database.exec(`create role fixture_quote_hostile nologin;alter default privileges in schema fluid_private grant all on functions to fixture_quote_hostile with grant option;create function fluid_private.quote_logo_vector_proposal(text) returns text language sql as $$select $1$$;`);
  metadataBefore=(await metadata(database)).rows;
  defaultsBefore=(await database.query('select defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows;
 } }); metadataAfter=(await metadata(db)).rows; await resetFixture(db);
}, 60_000);
afterAll(async () => { await db?.close(); });
it('accepts only the independently costed exact text quote policy', async () => {
 const check = async (p: unknown) => (await db.query<{ v: boolean }>('select fluid_private.valid_logo_vector_proposal_text_policy($1) v', [p])).rows[0]!.v;
 expect(await check(proposalPolicy())).toBe(true);
 for (const fields of [{ maximumCostMicrousd: 106496 }, { maxTools: 1 }, { model: 'other' }, { handlerVersion: 'strategy-openai-v1' }, { extra: 'provider' }, { maxInputTokens: null }]) expect(await check({ ...proposalPolicy(), ...fields })).toBe(false);
});
it('does not seed enabled policies or grant trusted quote execution to app roles', async () => {
 expect((await db.query("select * from fluid_private.logo_runtime_policies where operation='identity.logo_vector_propose'")).rows).toEqual([]);
 for (const role of ['anon', 'authenticated', 'service_role']) expect((await db.query<{ v: boolean }>("select has_function_privilege($1,'fluid_private.quote_logo_vector_proposal(uuid,jsonb)','EXECUTE') v", [role])).rows[0]!.v).toBe(false);
});

import { randomUUID } from 'node:crypto';
import { asRole, OWNER_A, OWNER_B } from './local-supabase';
import { logoWorkspaceV2Schema } from '@/domain/logo-workspace';
import { logoCostQuoteSchema } from '@/domain/logo-jobs';
import { proposalFixture } from '../features/logo-vector/proposal-fixtures';
import { buildLogoVectorProposalContext } from '@/features/logo-vector/server/proposal-context';
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";
const ROLE = 'fixture_proposal_quote';
async function worker<T>(run: () => Promise<T>) { await db.exec(`set session authorization ${ROLE}`); try { return await run(); } finally { await db.exec('set session authorization postgres'); } }
async function quoteFixture() {
 await resetFixture(db);
 await db.exec(`do $$begin if not exists(select 1 from pg_roles where rolname='${ROLE}') then create role ${ROLE} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;end if;end$$;
  grant usage on schema public,fluid_private to ${ROLE};grant execute on function fluid_private.quote_logo_vector_proposal(uuid,jsonb),public.report_logo_worker_ready(text,jsonb,integer) to ${ROLE};`);
 for (const table of ['logo_asset_web_principals','logo_worker_principals']) await db.query(`insert into fluid_private.${table}(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2 on conflict(role_name) do update set role_oid=excluded.role_oid,owner_id=excluded.owner_id`,[OWNER_A,ROLE]);
 const start = logoWorkspaceV2Schema.parse(await startLogoFixture(ownerQuery(db), {requestKey:randomUUID(),brief:{name:'Aster',activity:'Synthetic quote metadata',audience:'',personality:'',logoTypes:['combination']}}));
 const f=proposalFixture(), brief=(await db.query<{record:typeof f.brief}>('select record from public.logo_stage_revisions where id=$1',[start.stages.brief_references!.id])).rows[0]!.record;
 f.brief=brief;f.revision.ownerId=OWNER_A;f.revision.projectId=start.projectId;f.revision.inputRevisions=[{stage:'brief_references',id:brief.id,revision:brief.revision}];
 for(const ref of [f.revision.sourcePreview,f.revision.documentAsset,f.revision.svgAsset]) {ref.ownerId=OWNER_A;ref.projectId=start.projectId;}
 for(const font of f.fonts){font.asset.ownerId=OWNER_A;font.asset.projectId=start.projectId;await db.query('insert into public.logo_font_records(record_id,version_id,owner_id,project_id,record) values($1,$2,$3,$4,$5)',[font.id,font.asset.versionId,OWNER_A,start.projectId,font]);}
 await db.query('insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)',[f.revision.id,OWNER_A,start.projectId,f.revision]);
 await db.query("select fluid_private.logo_append_stage($1,$2,'vector',$3,$4)",[OWNER_A,start.projectId,{vectorRevisionId:f.revision.id,approvalId:null},f.revision.inputRevisions]);
 const workspace=logoWorkspaceV2Schema.parse((await db.query<{v:unknown}>('select fluid_private.logo_workspace_json($1,$2) v',[OWNER_A,start.projectId])).rows[0]!.v);
 const context=buildLogoVectorProposalContext(f),request={operation:'propose_vector_edit',expected:workspace.heads,baseVectorRevisionId:f.revision.id,instruction:'Rotate the symbol',targetComponentIds:f.targetComponentIds};
 const evidence={version:1,request,context,baseRevision:f.revision,brief,fonts:f.fonts};
 const policy=proposalPolicy(),policyIdentity=(await db.query<{v:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') v",[policy])).rows[0]!.v;
 const configure=async(enabled=true,ready=true)=>{
  await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled,text_policy) values($1,'identity.logo_vector_propose',$2,'logo-vector-propose-v1','openai','gpt-6.1-sol',122880,$3,$4) on conflict(owner_id,operation) do update set enabled=excluded.enabled,text_policy=excluded.text_policy",[OWNER_A,policyIdentity,enabled,policy]);
  await db.query('update public.usage_accounts set limit_microusd=5000000 where owner_id=$1',[OWNER_A]);
  if(ready)expect((await worker(()=>db.query<{v:boolean}>("select public.report_logo_worker_ready('quote-fixture',$1,90) v",[[{operation:'identity.logo_vector_propose',policyIdentity,handlerVersion:'logo-vector-propose-v1',provider:'openai',model:'gpt-6.1-sol',engine:null,maxCostMicrousd:122880,textPolicy:policy}]]))).rows[0]!.v).toBe(true);
 };
 const quote=(body:unknown=evidence)=>worker(async()=>(await db.query<{v:unknown}>('select fluid_private.quote_logo_vector_proposal($1,$2) v',[start.projectId,body])).rows[0]!.v);
 return{evidence,quote,configure,projectId:start.projectId,policy,policyIdentity};
}
it('quotes only after exact independent policy, readiness and owner/source checks, without reserving or creating jobs',async()=>{
 const f=await quoteFixture();await expect(f.quote()).rejects.toMatchObject({code:'55000'});await f.configure(true,false);await expect(f.quote()).rejects.toMatchObject({code:'55000'});await f.configure();
 const quote=logoCostQuoteSchema.parse(await f.quote());expect(quote).toMatchObject({request:f.evidence.request,textPolicy:f.policy,maxCostMicrousd:122880});
 const stored=(await db.query<{source_inputs:unknown}>('select source_inputs from public.logo_cost_quotes where id=$1',[quote.id])).rows[0]!;expect(stored.source_inputs).toMatchObject({context:f.evidence.context,baseRevision:f.evidence.baseRevision,fonts:f.evidence.fonts});
 expect((await db.query('select * from public.jobs')).rows).toEqual([]);expect((await db.query('select * from public.usage_reservations')).rows).toEqual([]);
 await expect(asRole(db,'authenticated',OWNER_A,()=>db.query('select fluid_private.quote_logo_vector_proposal($1,$2)',[f.projectId,f.evidence]))).rejects.toMatchObject({code:'42501'});
 await db.query('update fluid_private.logo_asset_web_principals set owner_id=$1 where role_name=$2',[OWNER_B,ROLE]);await expect(f.quote()).rejects.toBeDefined();
});
it('rejects changed heads, immutable source, font metadata, context and underfunded budget before quote insertion',async()=>{
 const f=await quoteFixture();await f.configure();
 for(const change of [
  {...f.evidence,request:{...f.evidence.request,expected:{...f.evidence.request.expected,workspaceRevision:99}}},
  {...f.evidence,baseRevision:{...f.evidence.baseRevision,documentHash:'0'.repeat(64)}},
  {...f.evidence,context:{...f.evidence.context,documentHash:'0'.repeat(64)}},
  {...f.evidence,fonts:f.evidence.fonts.map((v,i)=>i===0?{...v,family:'Substituted'}:v)},
 ])await expect(f.quote(change)).rejects.toMatchObject({code:'PT409'});
 await db.query('update public.usage_accounts set limit_microusd=1 where owner_id=$1',[OWNER_A]);await expect(f.quote()).rejects.toMatchObject({code:'PT409'});
 expect((await db.query('select * from public.logo_cost_quotes')).rows).toEqual([]);
});
it('rejects duplicate full-font bindings rather than omitting one frozen summary',async()=>{
 const f=await quoteFixture();await f.configure();
 await expect(f.quote({...f.evidence,fonts:[f.evidence.fonts[0],f.evidence.fonts[0]]})).rejects.toBeDefined();
 expect((await db.query('select * from public.logo_cost_quotes')).rows).toEqual([]);
});
it('retains the shared API uncertainty pause for an independently configured proposal quote',async()=>{
 const f=await quoteFixture();await f.configure();
 await db.query("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,state) values($1,$2,'strategy.reformulate',1,$3,'{}',$4,100,'needs_reconciliation')",[OWNER_A,f.projectId,'a'.repeat(64),randomUUID()]);
 await expect(f.quote()).rejects.toMatchObject({code:'55000'});expect((await db.query('select * from public.logo_cost_quotes')).rows).toEqual([]);
});
it('preserves legacy quote hash serialization despite the new nullable policy column',async()=>{
 const f=await quoteFixture();
 const manifest={operation:'identity.logo_concept',policyIdentity:'a'.repeat(64),handlerVersion:'logo-image-v1',provider:'openai',model:'gpt-image-2.5-sunburst-2026-09-08',engine:null,maxCostMicrousd:100};
 await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_concept',$2,'logo-image-v1','openai',$3,100,true)",[OWNER_A,manifest.policyIdentity,manifest.model]);
 expect((await worker(()=>db.query<{v:boolean}>("select public.report_logo_worker_ready('quote-fixture',$1,90) v",[[manifest]]))).rows[0]!.v).toBe(true);
 const request={operation:'concepts',expected:f.evidence.request.expected,briefRevisionId:f.evidence.brief.id,referenceSnapshotId:f.evidence.brief.payload.referenceSnapshotId};
 const quote=logoCostQuoteSchema.parse(await asRole(db,'authenticated',OWNER_A,async()=>(await db.query<{v:unknown}>('select public.quote_logo_operation($1,$2) v',[f.projectId,request])).rows[0]!.v));
 const expected=(await db.query<{v:string}>("select encode(sha256(convert_to(jsonb_build_object('request',q.record->'request','sources',q.source_inputs,'policy',to_jsonb(p)-'subscription_policy'-'text_policy','plan',q.record->'conceptPlan','targets',q.record->'targetSlotIds')::text,'UTF8')),'hex') v from public.logo_cost_quotes q join fluid_private.logo_runtime_policies p on p.owner_id=q.owner_id and p.operation=q.operation where q.id=$1",[quote.id])).rows[0]!.v;
 expect(quote.inputHash).toBe(expected);expect(quote).not.toHaveProperty('textPolicy');
});

it('preserves existing function metadata and scrubs only the new exact helper signatures',async()=>{
 expect(metadataAfter).toEqual(metadataBefore);
 expect((await db.query('select defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows).toEqual(defaultsBefore);
 for(const signature of ['fluid_private.valid_logo_vector_proposal_text_policy(jsonb)','fluid_private.quote_logo_vector_proposal(uuid,jsonb)']) expect((await db.query<{v:boolean}>("select has_function_privilege('fixture_quote_hostile',$1,'EXECUTE') v",[signature])).rows[0]!.v).toBe(false);
 expect((await db.query<{v:boolean}>("select has_function_privilege('fixture_quote_hostile','fluid_private.quote_logo_vector_proposal(text)','EXECUTE') v")).rows[0]!.v).toBe(true);
});
it('rejects role OID rebinding and foreign context at the trusted SQL boundary',async()=>{
 const f=await quoteFixture();await f.configure();
 await expect(f.quote({...f.evidence,context:{...f.evidence.context,ownerId:OWNER_B}})).rejects.toMatchObject({code:'22023'});
 await db.query('update fluid_private.logo_asset_web_principals set role_oid=(role_oid::bigint+100000)::oid where role_name=$1',[ROLE]);
 await expect(f.quote()).rejects.toMatchObject({code:'42501'});expect((await db.query('select * from public.logo_cost_quotes')).rows).toEqual([]);
});
it('rejects a context already larger than the independently selected input byte policy',async()=>{
 const f=await quoteFixture();await f.configure();const policy={...f.policy,maxInputBytes:1024};
 const hash=(await db.query<{v:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') v",[policy])).rows[0]!.v;
 await db.query("update fluid_private.logo_runtime_policies set text_policy=$1,policy_identity=$2 where owner_id=$3 and operation='identity.logo_vector_propose'",[policy,hash,OWNER_A]);
 expect((await worker(()=>db.query<{v:boolean}>("select public.report_logo_worker_ready('quote-fixture',$1,90) v",[[{operation:'identity.logo_vector_propose',policyIdentity:hash,handlerVersion:'logo-vector-propose-v1',provider:'openai',model:'gpt-6.1-sol',engine:null,maxCostMicrousd:122880,textPolicy:policy}]]))).rows[0]!.v).toBe(true);
 await expect(f.quote()).rejects.toMatchObject({code:'22023'});expect((await db.query('select * from public.logo_cost_quotes')).rows).toEqual([]);
});
it('uses exact UTF-8 envelope bytes and accepts the policy boundary without truncation',async()=>{
 const f=await quoteFixture();f.evidence.request.instruction='Rotate the symbol. Привет 🙂';await f.configure();
 const bytes=(await db.query<{v:number}>("select octet_length(jsonb_build_object('context',$1::jsonb,'instruction',$2::jsonb)::text) v",[f.evidence.context,JSON.stringify(f.evidence.request.instruction)])).rows[0]!.v;
 const policy={...f.policy,maxInputBytes:bytes},hash=(await db.query<{v:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') v",[policy])).rows[0]!.v;
 await db.query("update fluid_private.logo_runtime_policies set text_policy=$1,policy_identity=$2 where owner_id=$3 and operation='identity.logo_vector_propose'",[policy,hash,OWNER_A]);
 expect((await worker(()=>db.query<{v:boolean}>("select public.report_logo_worker_ready('quote-fixture',$1,90) v",[[{operation:'identity.logo_vector_propose',policyIdentity:hash,handlerVersion:'logo-vector-propose-v1',provider:'openai',model:'gpt-6.1-sol',engine:null,maxCostMicrousd:122880,textPolicy:policy}]]))).rows[0]!.v).toBe(true);
 const quote=logoCostQuoteSchema.parse(await f.quote());expect(quote.request).toEqual(f.evidence.request);
});
