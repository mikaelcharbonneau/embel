import { beforeAll, afterAll, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createTestDatabase, asRole, OWNER_A, OWNER_B, type TestDatabase } from './local-supabase';
import { materializationCandidates, materializationFixture } from './logo-vector-proposal-materialization-fixture';
import { WEB } from './logo-vector-proposal-admission-fixture';
const prior = materializationCandidates.slice(0, -1), candidate = materializationCandidates.at(-1)!;
const signatures = ['fluid_private.read_logo_trusted_request(uuid,jsonb)','fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)','fluid_private.logo_vector_edit_cancel_command_valid(jsonb)','fluid_private.logo_vector_edit_request_state(uuid,uuid,uuid)','public.cancel_logo_vector_edit(uuid,jsonb)','public.read_logo_vector_edit_request(uuid,uuid)','fluid_private.commit_logo_vector_edit(uuid,uuid,jsonb,jsonb)'];
const helpers = ['fluid_private.logo_vector_proposal_owned_asset_valid(uuid,uuid,jsonb,text)','fluid_private.logo_vector_proposal_basis_current(fluid_private.logo_vector_proposals)','fluid_private.logo_vector_proposal_application_command_valid(jsonb)','fluid_private.logo_vector_proposal_materializable(fluid_private.logo_vector_proposals)','fluid_private.commit_logo_vector_proposal(uuid,uuid,jsonb,jsonb)'];
const metadata = (db: TestDatabase) => db.query('select oid,proowner,proacl::text,prosecdef,provolatile,proparallel,proconfig,procost,prorows,proargdefaults::text from pg_proc where oid=any($1::regprocedure[]) order by oid', [signatures]);
let db: TestDatabase, before: unknown[], defaults: unknown[];
beforeAll(async () => {
  db = await createTestDatabase({ additionalMigrations: prior });
  await db.exec('create role fixture_materialization_hostile nologin;alter default privileges in schema fluid_private grant all on functions to fixture_materialization_hostile with grant option;alter default privileges in schema fluid_private grant all on tables to fixture_materialization_hostile with grant option;alter default privileges in schema public grant all on functions to fixture_materialization_hostile with grant option;create function fluid_private.commit_logo_vector_proposal(text) returns boolean language sql as $$select true$$;');
  await db.exec(`create role fixture_materialization_column nologin;
    create function public.fixture_materialization_column_grant() returns event_trigger language plpgsql as $$declare c record;begin
      for c in select * from pg_event_trigger_ddl_commands() loop
        if c.command_tag='CREATE TABLE' and c.object_identity='fluid_private.logo_vector_proposal_materializations' then
          grant select(record) on fluid_private.logo_vector_proposal_materializations to fixture_materialization_column with grant option;
        end if;
      end loop;
    end$$;
    create event trigger fixture_materialization_column_grant on ddl_command_end execute function public.fixture_materialization_column_grant();`);
  before = (await metadata(db)).rows; defaults = (await db.query('select defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows;
  if (candidate) await db.exec(candidate);
}, 60_000);
afterAll(async () => { await db?.close(); });
it('preserves existing OIDs/ACLs/security metadata, unrelated overloads and hostile default policies', async () => {
  expect((await metadata(db)).rows).toEqual(before);
  expect((await db.query('select defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows).toEqual(defaults);
  expect((await db.query<{ v: boolean }>("select has_function_privilege('fixture_materialization_hostile','fluid_private.commit_logo_vector_proposal(text)','EXECUTE') v")).rows[0]!.v).toBe(true);
});
it('scrubs hostile defaults on exact new objects and exposes only the bounded owner read', async () => {
  for (const role of ['anon','authenticated','service_role','fixture_materialization_hostile']) {
    for (const fn of helpers) expect((await db.query<{ v: boolean }>("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn])).rows[0]!.v, `${role} ${fn}`).toBe(false);
    expect((await db.query<{ v: boolean }>("select has_function_privilege($1,'public.read_logo_vector_proposal_application(uuid,uuid)','EXECUTE') v", [role])).rows[0]!.v).toBe(role === 'authenticated');
    for (const permission of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) expect((await db.query<{ v: boolean }>("select has_table_privilege($1,'fluid_private.logo_vector_proposal_materializations',$2) v", [role, permission])).rows[0]!.v).toBe(false);
  }
  expect((await db.query<{ v: boolean }>("select has_column_privilege('fixture_materialization_column','fluid_private.logo_vector_proposal_materializations','record','SELECT') v")).rows[0]!.v).toBe(false);
  expect((await db.query('select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass', ['fluid_private.logo_vector_proposal_materializations'])).rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
});
it('denies ordinary direct table access and direct helpers even with forged JWT owner claims', async () => {
  const f = await materializationFixture(db); await f.apply();
  for (const role of ['authenticated','anon','service_role'] as const) {
    for (const sql of ['select * from fluid_private.logo_vector_proposal_materializations','insert into fluid_private.logo_vector_proposal_materializations select * from fluid_private.logo_vector_proposal_materializations','delete from fluid_private.logo_vector_proposal_materializations','update fluid_private.logo_vector_proposal_materializations set owner_id=owner_id','truncate fluid_private.logo_vector_proposal_materializations']) await expect(asRole(db, role, OWNER_A, () => db.exec(sql))).rejects.toMatchObject({ code: '42501' });
    await expect(asRole(db, role, OWNER_A, () => db.query('select fluid_private.commit_logo_vector_proposal($1,$2,$3,$4)', [OWNER_A, f.workspace.projectId, f.command, f.evidence]))).rejects.toMatchObject({ code: '42501' });
  }
  await expect(asRole(db, 'anon', OWNER_A, () => db.query('select public.read_logo_vector_proposal_application($1,$2)', [f.workspace.projectId, f.prepared.id]))).rejects.toMatchObject({ code: '42501' });
});
it('uses actual session ownership before exact receipt replay and rejects changed role OIDs', async () => {
  const f = await materializationFixture(db), receipt = await f.apply(); expect(await f.preflight()).toEqual(receipt);
  await db.query('update fluid_private.logo_asset_web_principals set owner_id=$1 where role_name=$2', [OWNER_B, WEB]);
  await expect(f.preflight()).rejects.toMatchObject({ code: 'P0002' }); await expect(f.apply()).rejects.toMatchObject({ code: 'P0002' });
  await db.query('update fluid_private.logo_asset_web_principals set owner_id=$1,role_oid=(role_oid::bigint+100000)::oid where role_name=$2', [OWNER_A, WEB]);
  await expect(f.preflight()).rejects.toMatchObject({ code: '42501' }); await expect(f.apply()).rejects.toMatchObject({ code: '42501' });
});
it('rejects inherited/membership principals and privileged role flags before replay', async () => {
  const f = await materializationFixture(db); await f.apply();
  for (const flag of ['superuser','inherit','createdb','createrole','replication','bypassrls']) {
    await db.exec(`alter role ${WEB} ${flag}`); await expect(f.preflight()).rejects.toMatchObject({ code: '42501' }); await expect(f.apply()).rejects.toMatchObject({ code: '42501' }); await db.exec(`alter role ${WEB} no${flag}`);
  }
  await db.exec(`grant fixture_materialization_hostile to ${WEB}`); await expect(f.preflight()).rejects.toMatchObject({ code: '42501' }); await db.exec(`revoke fixture_materialization_hostile from ${WEB}`);
});
it('cannot invoke the web helper merely by SET ROLE while privileged session_user remains', async () => {
  const f = await materializationFixture(db);
  await db.exec(`set role ${WEB}`);
  try { await expect(db.query('select fluid_private.apply_logo_trusted_command($1,$2,$3)', [f.workspace.projectId, f.command, f.evidence])).rejects.toMatchObject({ code: '42501' }); } finally { await db.exec('reset role'); }
});
it('rolls the whole candidate back on an unknown exact predecessor without changing existing schema', async () => {
  const other = await createTestDatabase({ additionalMigrations: prior });
  try {
    const r = (await other.query<{ body: string; definition: string }>("select prosrc body,pg_get_functiondef(oid) definition from pg_proc where oid='fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)'::regprocedure")).rows[0]!;
    await other.exec(r.definition.replace(r.body, r.body + '\n-- changed predecessor\n'));
    await expect(other.exec(candidate)).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('proposal_materialization_predecessor_mismatch') });
    await other.exec('rollback'); expect((await other.query<{ v: unknown }>("select to_regclass('fluid_private.logo_vector_proposal_materializations') v")).rows[0]!.v).toBeNull();
  } finally { await other.close(); }
}, 60_000);
