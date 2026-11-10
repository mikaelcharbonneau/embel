import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDatabase, OWNER_A, OWNER_B } from "./local-supabase";

/** Local fixture logins bound to the baseline's Identity transaction helpers. No recovered
 * bytes, passwords, hosted roles or factory activation. */
export const identityFixturePrincipals: Readonly<Record<string, string>> = Object.freeze({
  [OWNER_A]: "fixture_identity_replacement_a",
  [OWNER_B]: "fixture_identity_replacement_b",
});
const helper = "fluid_identity_writer_definer_v1";
// Old worker identity functions kept because kept code still calls them; the baseline grants
// them by name to the helper. The job_steps policies that used them as predicates are retired.
const inherited = ["public.subscription_worker_owner()", "public.api_text_worker_owner()"];
const inheritedHashes: Record<string, string> = {
  subscription_worker_owner: "b8e9db7513576aef1db7860c844782b3d785f4b2ab71df42abe3f28aeb6743f1",
  // The baseline's definition, as the shared worker pool packet left it in production:
  // the shared Strategy context owner, falling back to the pinned legacy owner.
  api_text_worker_owner: "f1708c3cf65b4fbe6e0c8982bd0a3d0ae1fa4ff4316c0b2a6ca92d7f216a2131",
};
const logins = [...Object.values(identityFixturePrincipals), "fixture_identity_replacement_unbound"];
const entrypoints = [
  "fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)",
  "fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)",
];
// The baseline's shared Identity lane grants the helper these too (definer ones owned by postgres).
const packetDependencies: Record<string, boolean> = {
  "fluid_private.identity_application_design_valid(jsonb,jsonb)": false,
  "fluid_private.identity_board_contrast_ratio(text,text)": false,
  "fluid_private.identity_current_logo_brief(uuid,uuid)": true,
  "fluid_private.identity_job_logo_brief(uuid,uuid,uuid)": true,
  "fluid_private.shared_http_context_owner(text)": true,
};
const privateReads = ["fluid_private.identity_web_principals", "fluid_private.identity_system_applications"];
const dependencies = [
  "fluid_private.identity_web_owner()",
  "fluid_private.asset_library_project(public.projects)",
  "fluid_private.identity_session_json(public.identity_sessions)",
  "fluid_private.identity_preferences_json(public.identity_preferences)",
  "fluid_private.identity_system_json(public.identity_system_versions)",
  "fluid_private.identity_selection_json(public.identity_selections)",
  "fluid_private.identity_change_json(public.identity_component_changes)",
  "fluid_private.identity_reference_entry(uuid,uuid,uuid)",
  "fluid_private.identity_time_key(text)",
];
const reads = [
  "projects",
  "project_revisions",
  "identity_reference_heads",
  "identity_references",
  "identity_reference_reactions",
  "identity_reference_snapshots",
  "identity_sessions",
  "identity_preferences",
  "identity_input_snapshots",
  "identity_batches",
  "identity_generated_roots",
  "identity_system_versions",
  "identity_system_files",
  "identity_selections",
  "identity_component_changes",
  "asset_usages",
  "jobs",
  "job_steps",
  "assets",
  "asset_versions",
];
const inserts = new Set([
  "identity_reference_snapshots",
  "identity_sessions",
  "identity_system_versions",
  "identity_system_files",
  "identity_selections",
  "identity_component_changes",
  "asset_usages",
]);
const updates: Record<string, string[]> = {
  projects: ["id"],
  identity_reference_heads: ["project_id"],
  identity_sessions: ["identity_revision", "current_selection_id", "updated_at"],
  jobs: ["id"],
  job_steps: ["step_key"],
  assets: ["used"],
};
const baselines = new WeakMap<PGlite, unknown>();
const inheritedBaselines = new WeakMap<PGlite, unknown>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function requireCatalog(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(`Identity replacement catalog prerequisite failed: ${detail}`);
}
async function schemaDatabaseACL(db: PGlite) {
  return {
    database: (
      await db.query("select datname,datacl::text from pg_catalog.pg_database where datname=current_database()")
    ).rows,
    schemas: (
      await db.query(
        "select nspname,nspowner,nspacl::text from pg_catalog.pg_namespace where nspname in ('public','fluid_private') order by nspname",
      )
    ).rows,
  };
}
async function inheritedCatalog(db: PGlite) {
  return {
    functions: (
      await db.query(
        "select p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,p.prosecdef definer,p.proconfig config,p.proacl::text acl,pg_get_functiondef(p.oid) definition from pg_catalog.pg_proc p where p.oid=any(select to_regprocedure(x)::oid from unnest($1::text[]) x) order by signature",
        [inherited],
      )
    ).rows,
  };
}
export async function createIdentityTrustedDatabase(): Promise<PGlite> {
  const db = await createTestDatabase();
  try {
    baselines.set(db, await schemaDatabaseACL(db));
    inheritedBaselines.set(db, await inheritedCatalog(db));
    await db.exec(await readFile(new URL("identity-trusted-replacement-roles.sql", import.meta.url), "utf8"));
    await bindIdentityFixturePrincipals(db);
    await inspectIdentityReplacementCatalog(db);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
export async function bindIdentityFixturePrincipals(db: PGlite): Promise<void> {
  const who = (await db.query<{ name: string }>("select session_user::text name")).rows[0];
  requireCatalog(who?.name === "postgres", "principal binding requires local bootstrap");
  await db.exec("truncate fluid_private.identity_web_principals");
  for (const [owner, name] of Object.entries(identityFixturePrincipals))
    await db.query(
      "insert into fluid_private.identity_web_principals(login_role_oid,login_role_name,owner_id) select oid,rolname,$2::uuid from pg_catalog.pg_roles where rolname=$1",
      [name, owner],
    );
}
export async function asIdentityFixture<T>(db: PGlite, ownerId: string, run: () => Promise<T>): Promise<T> {
  const role = identityFixturePrincipals[ownerId];
  if (!role) throw new Error("Unknown local Identity owner");
  await db.exec(`set session authorization ${role}`);
  try {
    return await run();
  } finally {
    if (db.isInTransaction()) await db.exec("rollback");
    await db.exec("discard all");
    await db.exec("set session authorization postgres");
  }
}
export async function inspectIdentityReplacementCatalog(db: PGlite) {
  const roles = (
    await db.query<{
      rolname: string;
      oid: number;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolinherit: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      "select oid,rolname,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_catalog.pg_roles where rolname=any($1::text[]) order by rolname",
      [[helper, ...logins]],
    )
  ).rows;
  requireCatalog(roles.length === 4, "exact four restricted roles");
  for (const role of roles)
    requireCatalog(
      role.rolcanlogin === (role.rolname !== helper) &&
        !role.rolsuper &&
        !role.rolinherit &&
        !role.rolcreatedb &&
        !role.rolcreaterole &&
        !role.rolreplication &&
        !role.rolbypassrls,
      role.rolname,
    );
  const memberships = (
    await db.query("select * from pg_catalog.pg_auth_members where member=any($1::oid[]) or roleid=any($1::oid[])", [
      roles.map((r) => r.oid),
    ])
  ).rows;
  requireCatalog(memberships.length === 0, "no role membership paths");
  const schemas = [];
  for (const role of roles) {
    const privileges = (
      await db.query<{
        connect: boolean;
        temp: boolean;
        create_db: boolean;
        public_usage: boolean;
        private_usage: boolean;
        public_create: boolean;
        private_create: boolean;
      }>(
        "select has_database_privilege($1,current_database(),'CONNECT') connect,has_database_privilege($1,current_database(),'TEMP') temp,has_database_privilege($1,current_database(),'CREATE') create_db,has_schema_privilege($1,'public','USAGE') public_usage,has_schema_privilege($1,'fluid_private','USAGE') private_usage,has_schema_privilege($1,'public','CREATE') public_create,has_schema_privilege($1,'fluid_private','CREATE') private_create",
        [role.rolname],
      )
    ).rows[0]!;
    requireCatalog(
      privileges.connect &&
        privileges.temp &&
        privileges.public_usage &&
        privileges.private_usage &&
        !privileges.create_db &&
        !privileges.public_create &&
        !privileges.private_create,
      `schema/database privileges ${role.rolname}`,
    );
    schemas.push({ role: role.rolname, ...privileges });
  }
  const functions = (
    await db.query<{
      oid: number;
      signature: string;
      name: string;
      owner: string;
      definer: boolean;
      config: string[];
      definition: string;
      acl: string | null;
    }>(
      "select p.oid,p.oid::regprocedure::text signature,p.proname name,pg_get_userbyid(p.proowner) owner,p.prosecdef definer,p.proconfig config,pg_get_functiondef(p.oid) definition,p.proacl::text acl from pg_catalog.pg_proc p where p.oid=any(select to_regprocedure(x)::oid from unnest($1::text[]) x) order by p.oid::regprocedure::text",
      [[...entrypoints, ...dependencies, ...inherited, ...Object.keys(packetDependencies)]],
    )
  ).rows;
  requireCatalog(
    functions.length === 18,
    "two entrypoints, nine invoker dependencies, two inherited worker identity functions, five shared Identity dependencies",
  );
  for (const fn of functions) {
    const entry = ["prepare_identity_transaction", "commit_identity_transaction"].includes(fn.name);
    const inheritedHash = inheritedHashes[fn.name];
    const packetDefiner = Object.entries(packetDependencies).find(([signature]) =>
      signature.startsWith(`fluid_private.${fn.name}(`),
    )?.[1];
    requireCatalog(
      fn.definer === (entry || !!inheritedHash || packetDefiner === true) &&
        fn.owner === (entry ? helper : "postgres") &&
        fn.config?.includes('search_path=""'),
      `function owner/search path ${fn.signature}`,
    );
    if (inheritedHash)
      requireCatalog(
        fn.owner === "postgres" &&
          digest(fn.definition) === inheritedHash &&
          /^\{postgres=X\/postgres(,[^=,]+=X\/postgres)*\}$/.test(fn.acl ?? ""),
        `unchanged inherited definition/ACL ${fn.signature}`,
      );
  }
  const functionACLs = (
    await db.query<{
      signature: string;
      grantee: number;
      grantee_name: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(
      "select p.oid::regprocedure::text signature,acl.grantee,case when acl.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end grantee_name,acl.privilege_type,acl.is_grantable from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl where p.oid=any($1::oid[]) order by signature,acl.grantee",
      [functions.map((fn) => fn.oid)],
    )
  ).rows;
  for (const row of functionACLs) {
    const fn = functions.find((candidate) => candidate.signature === row.signature)!;
    requireCatalog(
      row.privilege_type === "EXECUTE" && (!row.is_grantable || row.grantee_name === fn.owner),
      `narrow function ACL ${row.signature}`,
    );
    if (!inheritedHashes[fn.name]) requireCatalog(row.grantee !== 0, `no replacement PUBLIC execute ${row.signature}`);
  }
  const bindingTable = (
    await db.query<{ owner: string; acl: string }>(
      "select pg_get_userbyid(relowner) owner,relacl::text acl from pg_catalog.pg_class where oid='fluid_private.identity_web_principals'::regclass",
    )
  ).rows[0]!;
  requireCatalog(bindingTable.owner === "postgres", "bootstrap-owned principal binding");
  const bindingRights = [],
    unexpectedRelationRights = [];
  for (const role of roles) {
    const right = (
      await db.query<{ select: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean }>(
        "select has_table_privilege($1,'fluid_private.identity_web_principals','SELECT') select,has_any_column_privilege($1,'fluid_private.identity_web_principals','INSERT') insert,has_any_column_privilege($1,'fluid_private.identity_web_principals','UPDATE') update,has_table_privilege($1,'fluid_private.identity_web_principals','DELETE') delete,has_table_privilege($1,'fluid_private.identity_web_principals','TRUNCATE') truncate",
        [role.rolname],
      )
    ).rows[0]!;
    requireCatalog(
      right.select === (role.rolname === helper) && !right.insert && !right.update && !right.delete && !right.truncate,
      `private binding rights ${role.rolname}`,
    );
    bindingRights.push({ role: role.rolname, ...right });
    const unexpected = (
      await db.query(
        "select n.nspname,c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','fluid_private') and c.relkind in ('r','p','v','m') and not(n.nspname='public' and c.relname=any($2::text[])) and c.oid<>all(select x::regclass from unnest($3::text[]) x) and (has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') or has_table_privilege($1,c.oid,'DELETE,TRUNCATE,TRIGGER')) order by n.nspname,c.relname",
        [role.rolname, reads, privateReads],
      )
    ).rows;
    requireCatalog(unexpected.length === 0, `no unlisted data relation rights ${role.rolname}`);
    unexpectedRelationRights.push({ role: role.rolname, relations: unexpected });
  }
  const inheritedAfter = await inheritedCatalog(db);
  requireCatalog(
    JSON.stringify(inheritedAfter) === JSON.stringify(inheritedBaselines.get(db)),
    "unchanged inherited baseline definitions/ACL",
  );
  const workerBindings = (
    await db.query(
      "select role_name,role_oid from fluid_private.subscription_worker_principals where role_name=any($1::text[]) or role_oid=any($2::oid[]) union all select role_name,role_oid from fluid_private.api_text_worker_principals where role_name=any($1::text[]) or role_oid=any($2::oid[])",
      [[helper, ...logins], roles.map((r) => r.oid)],
    )
  ).rows;
  requireCatalog(workerBindings.length === 0, "replacement name/OID must have no worker binding");
  const executable = [];
  for (const role of roles) {
    const rows = (
      await db.query<{ oid: number; signature: string }>(
        "select p.oid,p.oid::regprocedure::text signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','fluid_private') and has_function_privilege($1,p.oid,'EXECUTE') order by p.oid::regprocedure::text",
        [role.rolname],
      )
    ).rows;
    const expected = functions
      .filter(
        (fn) =>
          role.rolname === helper || ["prepare_identity_transaction", "commit_identity_transaction"].includes(fn.name),
      )
      .map((fn) => fn.oid)
      .sort();
    requireCatalog(
      JSON.stringify(rows.map((row) => row.oid).sort()) === JSON.stringify(expected),
      `exact callable functions ${role.rolname}: ${rows.map((r) => r.signature).join(",")}`,
    );
    executable.push({ role: role.rolname, functions: rows });
  }
  const tables = (
    await db.query<{ name: string; owner: string; enabled: boolean; forced: boolean; acl: string | null }>(
      "select c.relname name,pg_get_userbyid(c.relowner) owner,c.relrowsecurity enabled,c.relforcerowsecurity forced,c.relacl::text acl from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) order by c.relname",
      [reads],
    )
  ).rows;
  requireCatalog(tables.length === reads.length, "all application dependencies exist");
  const columns = [];
  for (const table of tables) {
    requireCatalog(table.owner !== helper && table.enabled && table.forced, `RLS/table ownership ${table.name}`);
    for (const role of roles) {
      const rights = (
        await db.query<{
          name: string;
          select: boolean;
          insert: boolean;
          update: boolean;
          delete: boolean;
          truncate: boolean;
        }>(
          "select a.attname name,has_column_privilege($1,c.oid,a.attnum,'SELECT') select,has_column_privilege($1,c.oid,a.attnum,'INSERT') insert,has_column_privilege($1,c.oid,a.attnum,'UPDATE') update,has_table_privilege($1,c.oid,'DELETE') delete,has_table_privilege($1,c.oid,'TRUNCATE') truncate from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where n.nspname='public' and c.relname=$2 order by a.attnum",
          [role.rolname, table.name],
        )
      ).rows;
      for (const right of rights)
        requireCatalog(
          right.select === (role.rolname === helper) &&
            right.insert === (role.rolname === helper && inserts.has(table.name)) &&
            right.update === (role.rolname === helper && (updates[table.name] ?? []).includes(right.name)) &&
            !right.delete &&
            !right.truncate,
          `exact column grants ${role.rolname}.${table.name}.${right.name}`,
        );
      columns.push({ role: role.rolname, table: table.name, rights });
    }
  }
  const policies = (
    await db.query(
      "select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_catalog.pg_policies where schemaname='public' and tablename=any($1::text[]) order by tablename,policyname",
      [reads],
    )
  ).rows;
  const constraints = (
    await db.query(
      "select conrelid::regclass::text relation,conname,contype,convalidated,pg_get_constraintdef(oid) definition from pg_catalog.pg_constraint where conrelid=any(select ('public.'||x)::regclass from unnest($1::text[]) x) order by conrelid::regclass::text,conname",
      [reads],
    )
  ).rows;
  const triggers = (
    await db.query(
      "select tgrelid::regclass::text relation,tgname,tgenabled,tgisinternal,tgfoid::regprocedure::text function,pg_get_triggerdef(oid) definition from pg_catalog.pg_trigger where tgrelid=any(select ('public.'||x)::regclass from unnest($1::text[]) x) order by tgrelid::regclass::text,tgname",
      [reads],
    )
  ).rows;
  const expressions = (
    await db.query(
      "select d.adrelid::regclass::text relation,a.attname,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) expression from pg_catalog.pg_attrdef d join pg_catalog.pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where d.adrelid=any(select ('public.'||x)::regclass from unnest($1::text[]) x) order by d.adrelid::regclass::text,a.attnum",
      [reads],
    )
  ).rows;
  return {
    verified: true,
    roles,
    memberships,
    schemaDatabaseBefore: baselines.get(db) ?? null,
    schemaDatabaseAfter: await schemaDatabaseACL(db),
    schemas,
    inheritedBefore: inheritedBaselines.get(db),
    inheritedAfter,
    workerBindings,
    functionACLs,
    bindingTable,
    bindingRights,
    unexpectedRelationRights,
    functions: functions.map((fn) => ({ ...fn, definitionSha256: digest(fn.definition) })),
    executable,
    tables,
    columns,
    policies,
    constraints,
    triggers,
    expressions,
  };
}
