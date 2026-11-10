import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, enqueue, HASH, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";
import type { LogoWorkspaceV2 } from "../../src/domain/logo-workspace";
import { ownerQuery, startLogoFixture } from "../database/logo-project-fixture";
import { authenticatedPolicyFunctions, authenticatedWrapperFunctions, publicFunctions, reviewedLogoAndHomeFunctions, userFunctions } from "./client-functions";

// Uses the real greenfield migration in local PostgreSQL/WASM, with emulated Auth claims.
// It does not represent two live Supabase sessions or multi-connection concurrency.
describe("independent database boundary attacks", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  beforeEach(async () => { await resetFixture(db); });
  afterAll(async () => { await db?.close(); });
  // A direct login with no grants of its own, as the retired worker logins were.
  async function asUnrelatedLogin<T>(run: () => Promise<T>): Promise<T> {
    await db.exec("grant connect on database postgres to fixture_subscription_worker_a; grant usage on schema public to fixture_subscription_worker_a; set session authorization fixture_subscription_worker_a");
    try { return await run(); } finally { await db.exec("set session authorization postgres"); }
  }

  async function fullTenant(owner: string) {
    const project = await seedProject(db, owner);
    const asset = randomUUID(), version = randomUUID();
    const path = `${owner}/${project.id}/${asset}/${version}`;
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'qa_fixture')", [asset, owner, project.id]);
    await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance,storage_path) values($1,$2,$3,$4,1,1,$5,$5,'application/json','{\"source\":\"qa_local_fixture\"}',$6)", [version, owner, project.id, asset, HASH, path]);
    await asRole(db, "authenticated", owner, async () => {
      await db.query("select public.select_asset_version($1,$2,1,0,false)", [asset, version]);
      await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, owner]);
    });
    const job = await enqueue(db, project.id, "same-key-different-owners", 100, owner);
    // Administrative fixture creation only: application roles cannot insert job outputs.
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,output) values($1,$2,$3,'qa-step','qa-request','succeeded',0,'{\"source\":\"qa_local_fixture\"}')", [job.id, owner, project.id]);
    return { project: project.id, asset, version, path, job: job.id };
  }

  it("isolates populated rows in every owned public table and private storage in both directions", async () => {
    const a = await fullTenant(OWNER_A), b = await fullTenant(OWNER_B);
    const tables = ["projects", "project_revisions", "assets", "asset_versions", "asset_selections", "asset_heads", "asset_selection_receipts", "jobs", "job_steps", "usage_accounts", "usage_reservations"];
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        for (const table of tables) {
          expect((await db.query(`select owner_id from public.${table}`)).rows, table).toEqual([{ owner_id: owner }]);
        }
        expect((await db.query("select name from storage.objects")).rows).toEqual([{ name: own.path }]);
        for (const target of [own.asset, other.asset]) {
          await expect(db.query("update public.assets set liked=true,saved=true,used=true where id=$1 returning id", [target])).rejects.toMatchObject({ code: "42501" });
        }
        await expect(db.query("select public.set_asset_retention($1,0,true,true)", [other.asset])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.get_asset_detail($1,'{}')", [other.asset])).rejects.toMatchObject({ code: "P0002" });
        expect((await db.query("delete from storage.objects where name=$1 returning id", [other.path])).rows).toEqual([]);
        await expect(db.query("insert into public.asset_selections(project_id,asset_id,version_id,reason) values($1,$2,$3,'restored')", [own.project, own.asset, other.version])).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("select public.select_asset_version($1,$2,1,1,false)", [own.asset, other.version])).rejects.toMatchObject({ code: "P0002" });
      });
    }
  });

  it("isolates populated reference records, denies raw writes and protects captured history", async () => {
    const tables = ["identity_reference_heads", "identity_references", "identity_reference_reactions", "identity_reference_snapshots"];
    async function referenceTenant(owner: string) {
      const project = (await seedProject(db, owner)).id, asset = randomUUID(), version = randomUUID(), reference = randomUUID();
      // Administrative local metadata only; no actual bytes, import API or source fetch.
      await db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'qa_reference','reference_media')", [asset, owner, project]);
      await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance,storage_path) values($1,$2,$3,$4,1,1,$5,$5,'image/png','{}',$6)", [version, owner, project, asset, HASH, `${owner}/${project}/${asset}/${version}`]);
      await db.query("insert into public.identity_references(id,owner_id,project_id,asset_id,media_version_id,source,attribution,relevant_elements,tags) values($1,$2,$3,$4,$5,'user_supplied',$6::jsonb,'{logo,colors}','{qa-local}')", [reference, owner, project, asset, version, JSON.stringify({ label: "Explicit local fixture", creator: null, sourceUrl: null, rightsNote: null })]);
      await asRole(db, "authenticated", owner, () => db.query("select public.set_identity_reference_reaction($1,$2,'{\"expectedRevision\":0,\"ensemble\":false,\"elements\":[\"colors\"]}')", [project, reference]));
      // Invoke the private capture as fixture administrator, never via a new grant.
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
      try { await db.query("select fluid_private.capture_identity_reference_snapshot($1,1)", [project]); }
      finally { await db.query("select set_config('request.jwt.claim.sub','',false)"); }
      return { project, reference };
    }
    const a = await referenceTenant(OWNER_A), b = await referenceTenant(OWNER_B);
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        for (const table of tables) {
          expect((await db.query(`select owner_id from public.${table}`)).rows, table).toEqual([{ owner_id: owner }]);
          await expect(db.query(`insert into public.${table}(owner_id,project_id) values($1,$2)`, [owner, own.project])).rejects.toMatchObject({ code: "42501" });
          for (const target of [own.project, other.project]) {
            await expect(db.query(`update public.${table} set owner_id=$1 where project_id=$2`, [owner, target])).rejects.toMatchObject({ code: "42501" });
            await expect(db.query(`delete from public.${table} where project_id=$1`, [target])).rejects.toMatchObject({ code: "42501" });
          }
        }
        await expect(db.query("select public.get_identity_references($1,'{}')", [other.project])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.set_identity_reference_reaction($1,$2,'{}')", [own.project, other.reference])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select fluid_private.capture_identity_reference_snapshot($1,1)", [own.project])).rejects.toMatchObject({ code: "42501" });
      });
    }
    await asRole(db, "authenticated", null, async () => {
      for (const table of tables) expect((await db.query(`select owner_id from public.${table}`)).rows).toEqual([]);
      await expect(db.query("select public.get_identity_references($1,'{}')", [a.project])).rejects.toMatchObject({ code: "P0002" });
      await expect(db.query("select public.set_identity_reference_reaction($1,$2,'{}')", [a.project, a.reference])).rejects.toMatchObject({ code: "P0002" });
    });
    for (const role of ["anon", "service_role"] as const) await asRole(db, role, OWNER_A, async () => {
      for (const table of tables) {
        await expect(db.query(`select owner_id from public.${table}`)).rejects.toMatchObject({ code: "42501" });
        await expect(db.query(`update public.${table} set owner_id=$1 where project_id=$2`, [OWNER_A, a.project])).rejects.toMatchObject({ code: "42501" });
      }
    });
    await asUnrelatedLogin(async () => {
      for (const table of tables) await expect(db.query(`select owner_id from public.${table}`)).rejects.toMatchObject({ code: "42501" });
    });
    for (const table of ["identity_references", "identity_reference_snapshots"]) {
      await expect(db.query(`update public.${table} set owner_id=owner_id where project_id=$1`, [a.project])).rejects.toMatchObject({ code: "55000" });
      await expect(db.query(`delete from public.${table} where project_id=$1`, [a.project])).rejects.toMatchObject({ code: "55000" });
    }
  });

  it("isolates all populated logo tables and history RPCs without granting raw writes", async () => {
    const tables = ["logo_workspaces", "logo_stage_heads", "logo_stage_revisions", "logo_reference_sources", "logo_reference_snapshots", "logo_workspace_requests"];
    const brief = { name: "Explicit local logo fixture", activity: "", audience: "", personality: "", logoTypes: ["wordmark"] };
    async function logoTenant(owner: string) {
      const workspace = await startLogoFixture(ownerQuery(db, owner), { brief });
      const asset = randomUUID(), version = randomUUID(), reference = randomUUID();
      // Administrator-created local metadata only. No actual upload, source
      // admission, licensed rights, or provider output is claimed by this fixture.
      await db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'qa_reference','reference_media')", [asset, owner, workspace.projectId]);
      await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance) values($1,$2,$3,$4,1,1,$5,$5,'image/png','{}')", [version, owner, workspace.projectId, asset, HASH]);
      await db.query("insert into public.logo_reference_sources(reference_id,project_id,owner_id,asset_id,version_id,content_hash,source_kind,rights_evidence_id) values($1,$2,$3,$4,$5,$6,'upload',$7)", [reference, workspace.projectId, owner, asset, version, HASH, randomUUID()]);
      const snapshot = (await db.query<{ id: string }>("select id from public.logo_reference_snapshots where project_id=$1 and owner_id=$2", [workspace.projectId, owner])).rows[0]!.id;
      return { workspace, snapshot };
    }
    const a = await logoTenant(OWNER_A), b = await logoTenant(OWNER_B);
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        for (const table of tables) {
          expect((await db.query(`select owner_id from public.${table}`)).rows, table).toEqual([{ owner_id: owner }]);
          await expect(db.query(`insert into public.${table}(owner_id) values($1)`, [owner]), table).rejects.toMatchObject({ code: "42501" });
          for (const target of [own.workspace.projectId, other.workspace.projectId]) {
            await expect(db.query(`update public.${table} set owner_id=$1 where project_id=$2`, [owner, target]), table).rejects.toMatchObject({ code: "42501" });
            await expect(db.query(`delete from public.${table} where project_id=$1`, [target]), table).rejects.toMatchObject({ code: "42501" });
          }
        }
        await expect(db.query("select public.get_logo_workspace($1)", [other.workspace.projectId])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.read_logo_workspace_record($1,'stage',$2)", [own.workspace.projectId, other.workspace.stages.brief_references!.id])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.read_logo_workspace_record($1,'reference_snapshot',$2)", [own.workspace.projectId, other.snapshot])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.list_logo_workspace_records($1,'brief_references','{}')", [other.workspace.projectId])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.apply_logo_workspace_command($1,$2)", [other.workspace.projectId, {
          method: "saveLogoBrief", body: { requestKey: randomUUID(), expected: other.workspace.heads, brief },
        }])).rejects.toMatchObject({ code: "P0002" });
      });
    }
    await asRole(db, "authenticated", null, async () => {
      for (const table of tables) expect((await db.query(`select owner_id from public.${table}`)).rows, table).toEqual([]);
    });
    for (const role of ["anon", "service_role"] as const) await asRole(db, role, OWNER_A, async () => {
      for (const table of tables) {
        await expect(db.query(`select owner_id from public.${table}`), table).rejects.toMatchObject({ code: "42501" });
        await expect(db.query(`update public.${table} set owner_id=$1`, [OWNER_A]), table).rejects.toMatchObject({ code: "42501" });
      }
    });
    await asUnrelatedLogin(async () => {
      for (const table of tables) await expect(db.query(`select owner_id from public.${table}`), table).rejects.toMatchObject({ code: "42501" });
    });
    for (const table of ["logo_stage_revisions", "logo_reference_sources", "logo_reference_snapshots", "logo_workspace_requests"]) {
      await expect(db.query(`update public.${table} set owner_id=owner_id`), table).rejects.toMatchObject({ code: "55000" });
      await expect(db.query(`delete from public.${table}`), table).rejects.toMatchObject({ code: "55000" });
    }
  });

  it("fails closed when the authenticated database role has no subject claim", async () => {
    const a = await fullTenant(OWNER_A);
    await asRole(db, "authenticated", null, async () => {
      expect((await db.query("select id from public.projects")).rows).toEqual([]);
      expect((await db.query("select name from storage.objects")).rows).toEqual([]);
      await expect(db.query("select * from public.create_project('naming_only','No identity','{}',$1)", [HASH])).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.list_account_assets('{}')")).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.get_asset_detail($1,'{}')", [a.asset])).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.set_asset_retention($1,0,true,true)", [a.asset])).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.select_asset_version($1,$2,1,1,false)", [a.asset, a.version])).rejects.toThrow(/unauthenticated/);
      for (const signature of reviewedLogoAndHomeFunctions) {
        // Typed NULL arguments probe the reviewed exact overload, even if a
        // future overload has the same name and a different argument type.
        const invocation = signature.replace(/\((.*)\)$/, (_, types: string) =>
          `(${types ? types.split(", ").map(type => `null::${type}`).join(", ") : ""})`);
        await expect(db.query(`select ${invocation}`), signature).rejects.toMatchObject({ code: "42501", message: "unauthenticated" });
      }
      // The Logo workspace RPCs must reject a missing UID before processing input.
      for (const sql of [
        "select public.get_logo_workspace(null)",
        "select public.read_logo_workspace_record(null,null,null)",
        "select public.list_logo_workspace_records(null,null,null)",
        "select public.apply_logo_workspace_command(null,null)",
      ]) {
        await expect(db.query(sql), sql).rejects.toMatchObject({ code: "42501", message: "unauthenticated" });
      }
    });
  });

  it("keeps private helpers and all worker functions unavailable to client roles", async () => {
    const grants = await db.query<{ signature: string; anonymous: boolean; authenticated: boolean; worker: boolean; unrelated_login: boolean }>(
      "select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature,has_function_privilege('anon',p.oid,'execute') as anonymous,has_function_privilege('authenticated',p.oid,'execute') as authenticated,has_function_privilege('service_role',p.oid,'execute') as worker,has_function_privilege('fixture_subscription_worker_a',p.oid,'execute') as unrelated_login from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','fluid_private')",
    );
    // service_role and a direct login keep only the two identity helpers, plus the
    // server's account deletion and cleanup functions (service_role only;
    // 20261110200000_account_deletion_and_export). No worker login gets them.
    const workerFunctions = new Set([...publicFunctions,
      "public.account_deletion_begin(uuid)",
      "public.account_deletion_purge(uuid)",
      "public.account_storage_objects(uuid, text, integer)",
      "public.account_deletion_files_removed(uuid, integer)",
      "public.account_deletion_complete(uuid)",
      "public.account_deletions_pending(interval, integer)",
      "public.orphaned_storage_objects(text, integer)",
    ]);
    // The baseline grants the worker helpers by name to production's roles, so a login
    // created afterwards executes nothing.
    const unrelatedLoginFunctions = new Set<string>();
    expect(grants.rows.length).toBeGreaterThan(10);
    expect(new Set(grants.rows.filter(grant => grant.authenticated).map(grant => grant.signature))).toEqual(userFunctions);
    expect(new Set(grants.rows.filter(grant => grant.worker).map(grant => grant.signature))).toEqual(workerFunctions);
    expect(new Set(grants.rows.filter(grant => grant.unrelated_login).map(grant => grant.signature))).toEqual(unrelatedLoginFunctions);
    for (const grant of grants.rows) {
      expect(grant.anonymous, grant.signature).toBe(false);
      expect(grant.authenticated, grant.signature).toBe(userFunctions.has(grant.signature));
      expect(grant.worker, grant.signature).toBe(workerFunctions.has(grant.signature));
      expect(grant.unrelated_login, grant.signature).toBe(unrelatedLoginFunctions.has(grant.signature));
    }
    expect((await db.query("select has_schema_privilege('authenticated','fluid_private','USAGE') as usage")).rows).toEqual([{ usage: false }]);
    for (const signature of [...authenticatedPolicyFunctions, ...authenticatedWrapperFunctions]) {
      expect((await db.query("select has_function_privilege('authenticated',$1,'EXECUTE WITH GRANT OPTION') as grantable", [signature])).rows).toEqual([{ grantable: false }]);
    }
    for (const owner of [OWNER_A, null]) await asRole(db, "authenticated", owner, async () => {
      await expect(db.query("select fluid_private.owner_staging_object_allowed('fluid-assets','unlisted')")).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select fluid_private.create_project_with_request(null,null,null,null,null)")).rejects.toMatchObject({ code: "42501" });
    });
    const columns = await db.query<{ column_name: string }>(
      "select attname as column_name from pg_attribute where attrelid='public.job_steps'::regclass and attnum>0 and not attisdropped and has_column_privilege('fixture_subscription_worker_a',attrelid,attnum,'select') order by attname",
    );
    expect(columns.rows).toEqual([]);
  });

  // Pre-launch abuse test (docs/architecture-review.md, M3). Every function a signed-in
  // user may execute is the reviewed userFunctions list above (asserted exactly by the
  // previous test). Here user A calls each one with user B's real identifiers in every
  // argument position, the way a script would through PostgREST. Each call must either
  // fail, or succeed without returning any of B's data and without changing any of B's
  // rows or files. Calls run in a transaction that is rolled back, so A's own side
  // effects don't accumulate between calls.
  it("lets no client-callable function return or change another owner's data, whatever ids it is given", async () => {
    const b = await fullTenant(OWNER_B);
    const marker = `qa-b-private-${randomUUID()}`;
    const bProject = (await asRole(db, "authenticated", OWNER_B, async () =>
      (await db.query<{ id: string }>("select id from public.create_project('complete_brand',$1,$2::jsonb,$3)", [marker, { description: marker }, HASH])).rows[0]!.id));
    const bRun = (await asRole(db, "authenticated", OWNER_B, async () =>
      (await db.query<{ id: string }>("select id from public.start_generation($1,'engine.probe',$2,$3::jsonb)", [bProject, `qa-sweep-${randomUUID()}`, { note: marker }])).rows[0]!.id));
    await db.query("select fluid_private.engine_claim($1,'wrun_qa_sweep')", [bRun]);
    await db.query("select fluid_private.engine_save_output($1,'echo',$2::jsonb,null,0)", [bRun, { text: marker }]);
    const a = await seedProject(db, OWNER_A);
    await db.exec(`create schema qa_probe;
      create function qa_probe.owner_fingerprint(p_owner uuid) returns text language plpgsql as $$
      declare t record; part text; acc text := '';
      begin
        for t in select c.oid::regclass as rel, string_agg(format('%I = $1', a.attname), ' or ') as filter
                   from pg_class c join pg_attribute a on a.attrelid = c.oid
                  where c.relnamespace in ('public'::regnamespace, 'fluid_private'::regnamespace) and c.relkind in ('r','p')
                    and a.attname in ('owner_id','auth_user_id') and a.atttypid = 'uuid'::regtype and not a.attisdropped
                  group by c.oid order by 1
        loop
          execute format('select %L || coalesce(md5(string_agg(to_jsonb(x)::text, '','' order by to_jsonb(x)::text)), ''-'') from %s x where %s', t.rel::text, t.rel, t.filter)
            into part using p_owner;
          acc := md5(acc || part);
        end loop;
        select md5(acc || coalesce(string_agg(to_jsonb(o)::text, ',' order by o.name), '-')) into acc
          from storage.objects o where o.owner_id = p_owner::text or o.name like p_owner::text || '/%';
        return acc;
      end $$;`);
    try {
      const fingerprint = async () => (await db.query<{ f: string }>("select qa_probe.owner_fingerprint($1) as f", [OWNER_B])).rows[0]!.f;
      const before = await fingerprint();
      const bIds = [bProject, bRun, b.project, b.asset, b.version, b.job];
      const secrets = [OWNER_B, marker, ...bIds, b.path];
      const literal = (type: string, id: string) => {
        switch (type) {
          case "uuid": return `'${id}'::uuid`;
          case "uuid[]": return `array['${bIds.join("','")}']::uuid[]`;
          case "text": return `'${id}'`;
          case "jsonb": return `'${JSON.stringify({ projectId: id, runId: bRun, assetId: b.asset, versionId: b.version, jobId: b.job, batchId: id, referenceId: id,
            id, ownerId: OWNER_B, path: b.path, limit: 50, expected: { projectRevision: 1 }, tab: "all_generations", projectIds: bIds })}'::jsonb`;
          case "integer": case "bigint": return "1";
          case "boolean": return "true";
          case "timestamp with time zone": return "now()";
          default: return `null::${type}`;
        }
      };
      let calls = 0, refused = 0;
      for (const signature of [...userFunctions].sort()) {
        const name = signature.slice(0, signature.indexOf("("));
        const types = signature.slice(signature.indexOf("(") + 1, -1).split(", ").filter(Boolean);
        // Every one of B's ids in every position, and A's own project first with B's ids after it.
        const variants: string[][] = bIds.flatMap(id => [
          types.map(type => literal(type, id)),
          types.map((type, i) => i === 0 && type === "uuid" ? literal(type, a.id) : literal(type, id)),
        ]);
        await db.exec("begin");
        try {
          await asRole(db, "authenticated", OWNER_A, async () => {
            for (const args of variants) {
              calls++;
              await db.exec("savepoint probe");
              let text: string | null = null;
              try { text = JSON.stringify((await db.query(`select to_jsonb(r) as result from ${name}(${args.join(", ")}) r`)).rows); }
              catch { refused++; await db.exec("rollback to savepoint probe"); }
              for (const secret of secrets) expect(text?.includes(secret) ?? false, `${signature}(${args.join(", ")}) returned ${secret}`).toBe(false);
            }
          });
          expect(await fingerprint(), `${signature} changed B's rows or files`).toBe(before);
        } finally { await db.exec("rollback"); }
      }
      expect(calls).toBe(userFunctions.size * bIds.length * 2);
      expect(refused).toBeGreaterThan(calls / 2);
      expect(await fingerprint()).toBe(before);
    } finally {
      await db.exec("drop schema qa_probe cascade");
    }
  }, 300_000);

  it("rejects foreign project reads across the new logo and Home client surface in both directions", async () => {
    const a = await seedProject(db, OWNER_A), b = await seedProject(db, OWNER_B);
    // Each target is a real project owned by the other subject, not a guessed
    // absent UUID. Project-scoped readers must fence it before looking up data.
    const projectReads = [
      "select public.read_logo_current_vector($1)",
      "select public.read_logo_request($1,null)",
      "select public.read_logo_deliverable_sources($1)",
      "select public.get_logo_deliverables($1,'{}')",
      "select public.read_logo_input_request($1,null)",
      "select public.list_logo_input_references($1,'{\"limit\":20}')",
      "select public.list_logo_input_fonts($1)",
      "select public.list_logo_input_requests($1,'{\"limit\":10}')",
    ];
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        for (const sql of projectReads) await expect(db.query(sql, [other.id]), sql).rejects.toMatchObject({ code: "P0002" });
        const ownFonts = await db.query<{ value: unknown }>("select public.list_logo_input_fonts($1) as value", [own.id]);
        expect(ownFonts.rows).toEqual([{ value: [] }]);
      });
    }
  });

  it("denies foreign-project input cancellation before creating any request or tombstone", async () => {
    const a = await seedProject(db, OWNER_A), b = await seedProject(db, OWNER_B);
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        const workspace = (await db.query<{ value: LogoWorkspaceV2 }>("select public.get_logo_workspace($1) as value", [own.id])).rows[0]!.value;
        // Fully valid metadata reaches the owned-project lock. An invalid body
        // could fail earlier and leave a missing authorization check undetected.
        const request = {
          kind: "reference_upload",
          input: { requestKey: randomUUID(), expected: workspace.heads, aspects: ["shape"], rightsDeclaration: "Explicit local fixture rights" },
          file: { contentHash: HASH, mimeType: "image/png", byteLength: 24 },
        };
        await expect(db.query("select public.cancel_logo_input_request($1,$2)", [other.id, request])).rejects.toMatchObject({ code: "P0002" });
      });
    }
    expect((await db.query("select owner_id,project_id,request_key from public.logo_input_requests")).rows).toEqual([]);
    expect((await db.query("select owner_id,project_id,request_key from public.logo_input_rejections")).rows).toEqual([]);
  });

  it("denies direct calls to renamed base readers while the authenticated wrappers still work", async () => {
    const project = await seedProject(db);
    async function attackBaseReaders() {
      await expect(db.query("select public.read_logo_workspace_base_record($1,'stage',$2)", [project.id, randomUUID()])).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select public.list_logo_workspace_base_records($1,'brief_references','{}')", [project.id])).rejects.toMatchObject({ code: "42501" });
    }
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await asRole(db, role, OWNER_A, attackBaseReaders);
    }
    await asUnrelatedLogin(attackBaseReaders);
    await asRole(db, "authenticated", OWNER_A, async () => {
      const page = await db.query<{ value: { items: unknown[] } }>("select public.list_logo_workspace_records($1,'brief_references','{}') as value", [project.id]);
      expect(page.rows[0]!.value.items).toEqual([]);
      // Reaching the checked not-found result proves wrapper -> private base
      // delegation still works without exposing the base function to clients.
      await expect(db.query("select public.read_logo_workspace_record($1,'stage',$2)", [project.id, randomUUID()])).rejects.toMatchObject({ code: "P0002" });
    });
  });

  it("prevents user and worker DML on immutable history and accounting", async () => {
    const a = await fullTenant(OWNER_A);
    for (const role of ["authenticated", "service_role"] as const) {
      await asRole(db, role, role === "authenticated" ? OWNER_A : null, async () => {
        await expect(db.query("update public.asset_versions set content='{}' where id=$1", [a.version])).rejects.toThrow(/permission denied/);
        await expect(db.query("update public.asset_heads set selection_revision=0 where asset_id=$1", [a.asset])).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("update public.asset_selection_receipts set accepted_stale_basis=true where asset_id=$1", [a.asset])).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("delete from public.project_revisions where project_id=$1", [a.project])).rejects.toThrow(/permission denied/);
        await expect(db.query("update public.job_steps set output='{}' where job_id=$1", [a.job])).rejects.toThrow(/permission denied/);
        await expect(db.query("update public.usage_accounts set reserved_microusd=0")).rejects.toThrow(/permission denied/);
        await expect(db.query("delete from public.usage_reservations where job_id=$1", [a.job])).rejects.toThrow(/permission denied/);
      });
    }
  });

  it("rejects cross-project version selection within the same owner", async () => {
    const a = await fullTenant(OWNER_A);
    const otherProject = await seedProject(db, OWNER_A);
    const otherAsset = randomUUID();
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'qa_fixture')", [otherAsset, OWNER_A, otherProject.id]);
    await asRole(db, "authenticated", OWNER_A, async () => {
      await expect(db.query("insert into public.asset_selections(project_id,asset_id,version_id,reason) values($1,$2,$3,'restored')", [otherProject.id, otherAsset, a.version])).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select public.select_asset_version($1,$2,1,0,false)", [otherAsset, a.version])).rejects.toMatchObject({ code: "P0002" });
    });
    await expect(db.query("insert into public.asset_selections(owner_id,project_id,asset_id,version_id,reason) values($1,$2,$3,$4,'restored')", [OWNER_A, otherProject.id, otherAsset, a.version])).rejects.toMatchObject({ code: "23503" });
    expect((await db.query("select current_selection_id,selection_revision from public.asset_heads where asset_id=$1", [otherAsset])).rows).toEqual([{ current_selection_id: null, selection_revision: 0 }]);
  });

  it("rolls back a malformed job's reservation and keeps same-key requests scoped to one owner", async () => {
    const a = await seedProject(db), b = await seedProject(db, OWNER_B);
    await expect(enqueue(db, a.id, "invalid-attempts", 900, OWNER_A, 11)).rejects.toThrow(/check constraint/);
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ reserved_microusd: 0 }]);
    const first = await enqueue(db, a.id, "shared-request-key", 50);
    const second = await enqueue(db, b.id, "shared-request-key", 50, OWNER_B);
    expect(second.id).not.toBe(first.id);
  });

  // 20261110160000_harden_database_api.sql. Anonymous visitors can reach any function that
  // anon or PUBLIC may execute; new functions must start private.
  describe("database API hardening", () => {
    const identityHelpers = [
      "public.api_text_worker_owner()",
      "public.subscription_worker_owner()",
    ] as const;
    const executable = async (role: string, signature: string) =>
      (await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows[0]!.allowed;

    it("lets anonymous visitors execute no SECURITY DEFINER function in public, directly or through PUBLIC", async () => {
      const definers = await db.query<{ signature: string; anon: boolean; public_grant: boolean }>(
        `select p.oid::regprocedure::text as signature, has_function_privilege('anon',p.oid,'EXECUTE') as anon,
           exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_grant
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef`);
      expect(definers.rows.length).toBeGreaterThan(50);
      expect(definers.rows.filter(row => row.anon || row.public_grant)).toEqual([]);
      await asRole(db, "anon", null, async () => {
        for (const sql of [
          "select public.api_text_worker_owner()", "select public.subscription_worker_owner()",
        ]) await expect(db.query(sql), sql).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("keeps the old worker identity helpers executable for the lifecycle guards, and anonymous reads still stop at job_steps", async () => {
      for (const signature of identityHelpers) {
        expect(await executable("authenticated", signature), signature).toBe(true);
        expect(await executable("service_role", signature), signature).toBe(true);
      }
      await asRole(db, "authenticated", OWNER_A, async () => {
        expect((await db.query("select job_id from public.job_steps")).rows).toEqual([]);
      });
      // anon holds no privilege on job_steps (foundation migration), so its policies are never evaluated.
      await asRole(db, "anon", null, async () => {
        await expect(db.query("select job_id from public.job_steps")).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("no longer lets any API role execute set_project_deleted, which the app does not call", async () => {
      const signature = "public.set_project_deleted(uuid,integer,integer,boolean)";
      for (const role of ["anon", "authenticated", "service_role"]) expect(await executable(role, signature), role).toBe(false);
      const project = await seedProject(db);
      await asRole(db, "authenticated", OWNER_A, async () => {
        await expect(db.query("select public.set_project_deleted($1,1,0,true)", [project.id])).rejects.toMatchObject({ code: "42501" });
      });
      // The supported owner path is untouched.
      expect(await executable("authenticated", "public.request_project_deletion(uuid,integer,integer)")).toBe(true);
    });

    it("keeps a newly created function private until it is explicitly granted", async () => {
      await db.exec("create role qa_hardening_fresh nologin");
      try {
        await db.exec(`create function public.qa_hardening_probe() returns integer language sql as 'select 1';
          create function public.qa_hardening_definer() returns integer language sql security definer set search_path='' as 'select 1';
          create function fluid_private.qa_hardening_probe() returns integer language sql as 'select 1';`);
        const probes = ["public.qa_hardening_probe()", "public.qa_hardening_definer()", "fluid_private.qa_hardening_probe()"];
        for (const signature of probes) {
          // qa_hardening_fresh stands in for PUBLIC: it has no grants of its own.
          for (const role of ["anon", "authenticated", "qa_hardening_fresh"]) expect(await executable(role, signature), `${role} ${signature}`).toBe(false);
          expect(await executable("postgres", signature), signature).toBe(true);
          expect((await db.query<{ grantees: string[] | null }>(
            "select array_agg(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) grantees from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid=$1::regprocedure and a.grantee<>p.proowner", [signature])).rows[0]!.grantees ?? [])
            .not.toContain("PUBLIC");
        }
        // An explicit grant still works, and grants only what it names.
        await db.exec("grant execute on function public.qa_hardening_probe() to authenticated");
        expect(await executable("authenticated", "public.qa_hardening_probe()")).toBe(true);
        expect(await executable("anon", "public.qa_hardening_probe()")).toBe(false);
        expect(await executable("qa_hardening_fresh", "public.qa_hardening_probe()")).toBe(false);
      } finally {
        await db.exec("drop function if exists public.qa_hardening_probe(); drop function if exists public.qa_hardening_definer(); drop function if exists fluid_private.qa_hardening_probe(); drop role if exists qa_hardening_fresh");
      }
    });
  });
});
