import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {asRole,createTestDatabase,OWNER_A,OWNER_B,resetFixture,type TestDatabase} from './local-supabase';
import {logoWorkspaceV2Schema} from '../../src/domain/logo-workspace';
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";

const filename='20261030150000_logo_brief_context_freshness.sql';
describe('logo brief freshness compares exact owned saved context',()=>{
 let db:TestDatabase,packet:string,oldDefinition:string;
 let before:Record<string,unknown>,after:Record<string,unknown>;
 async function metadata(){return(await db.query<Record<string,unknown>>("select oid::text oid,proowner::text owner,proacl::text acl,prosecdef,provolatile,proleakproof,proconfig,encode(sha256(convert_to(prosrc,'UTF8')),'hex') body_hash from pg_proc where oid='fluid_private.logo_workspace_base_json(uuid,uuid)'::regprocedure")).rows[0]!;}
 beforeAll(async()=>{
  db=await createTestDatabase({before:filename});
  packet=await readFile(new URL('../../supabase/migrations/'+filename,import.meta.url),'utf8');
  before=await metadata();
  oldDefinition=(await db.query<{definition:string}>("select pg_get_functiondef('fluid_private.logo_workspace_base_json(uuid,uuid)'::regprocedure) definition")).rows[0]!.definition;
  await db.exec(packet);after=await metadata();
 },60000);
 afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{await resetFixture(db);});
 async function start(owner=OWNER_A){return logoWorkspaceV2Schema.parse(await startLogoFixture(ownerQuery(db, owner), {requestKey:randomUUID(),brief:{name:'Same context',activity:'Studio',audience:'Founders',personality:'Calm',logoTypes:['wordmark']}}));}
 async function read(project:string,owner=OWNER_A){return logoWorkspaceV2Schema.parse(await asRole(db,'authenticated',owner,async()=>(await db.query<{value:unknown}>('select public.get_logo_workspace($1) value',[project])).rows[0]!.value));}
 it('changes only the guarded body, retaining the function identity and all security metadata',()=>{
  expect(before.body_hash).toBe('0b6e77b1f06716421cfd3706b32f7df5bb303d81c21b397703526831a7ab4fd0');
  expect(after.body_hash).toBe('a7048b7df7505df2938c03823200a971254dbdedadfb9c2bc34d25376f6cef79');
  expect({...after,body_hash:before.body_hash}).toEqual(before);
 });
 it('rejects a changed predecessor and an accidental second install without overwriting either',async()=>{
  await db.exec('begin');
  await db.exec(oldDefinition.replace('declare project','declare /* unreviewed drift */ project'));
  await expect(db.exec(packet.replace(/^begin;$/m,''))).rejects.toMatchObject({code:'55000',message:'logo_brief_context_freshness_predecessor_mismatch'});
  await db.exec('rollback');expect(await metadata()).toEqual(after);
  await expect(db.exec(packet)).rejects.toMatchObject({code:'55000'});
  await db.exec('rollback');expect(await metadata()).toEqual(after);
 });
 it.each(['source','current','both'] as const)('fails closed when the %s saved revision is missing, including an unchanged revision counter',async(missing)=>{
  const workspace=await start(),project=workspace.projectId;
  // A second owned project's matching revision cannot stand in for a missing source.
  await start(OWNER_B);
  // A second saved version with the same content (for example a retitle) moves the revision counter only.
  if(missing!=='both'){const saved=(await db.query<{context:unknown;input_hash:string}>('select context,input_hash from public.project_revisions where project_id=$1 and revision=1',[project])).rows[0]!;
   await asRole(db,'authenticated',OWNER_A,()=>db.query('select public.append_project_revision($1,1,$2::jsonb,$3)',[project,JSON.stringify(saved.context),saved.input_hash]));}
  await db.exec('begin');
  try{
   // Deliberate LOCAL corruption fixture only; rollback restores the immutable rows and trigger.
   await db.exec('alter table public.project_revisions disable trigger revisions_immutable');
   await db.query('delete from public.project_revisions where owner_id=$1 and project_id=$2 and revision=$3',[OWNER_A,project,missing==='current'?2:1]);
   expect((await read(project)).staleStages).toContainEqual({stage:'brief_references',reasons:['project_revision_changed']});
  }finally{await db.exec('rollback');}
  expect((await read(project)).staleStages).toEqual([]);
 });
});
