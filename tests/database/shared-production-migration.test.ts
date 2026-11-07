import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeSharedProductionMigration, READ_ONLY_INVENTORY_SQL, READ_ONLY_PREREQUISITE_SQL, PRODUCTION_ORIGIN,
 PACKET_NAMES, PACKET_SHA256, POST_INSTALL_PACKETS, stripReviewedTransactionEnvelope } from "../../scripts/prepare-shared-production-migration.mjs";

const digest = (source: string) => createHash("sha256").update(source).digest("hex");
describe("reviewed packet transaction envelope", () => {
 it("removes only exact outer markers while preserving function/string/comment bytes", () => {
  const source = "-- begin;\nBEGIN;\nDO $x$ BEGIN PERFORM 'COMMIT;'; END $x$; /* nested /* COMMIT; */ */\nCOMMIT;\n";
  const result = stripReviewedTransactionEnvelope(source, digest(source));
  expect(result).toBe("-- begin;\n\nDO $x$ BEGIN PERFORM 'COMMIT;'; END $x$; /* nested /* COMMIT; */ */\n\n");
  expect(() => stripReviewedTransactionEnvelope(source + " ", digest(source))).toThrow("reviewed_source_hash_mismatch");
 });
 it.each(["COMMIT;", "ROLLBACK;", "SAVEPOINT x;", "RELEASE SAVEPOINT x;", "START TRANSACTION;", "PREPARE TRANSACTION 'x';", "SET TRANSACTION READ ONLY;", "SET LOCAL TRANSACTION READ ONLY;", "\\i other.sql\n"])("rejects extra outer transaction control or psql metadata %s", extra => {
  const source = `BEGIN;\n${extra}\nSELECT 1;\nCOMMIT;`;
  expect(() => stripReviewedTransactionEnvelope(source, digest(source))).toThrow();
 });
});

// This is a disposable native PostgreSQL17 fixture, not a production connection
// or live Auth/Storage proof. Cached image only, no ports/network/passwords.
describe("atomic shared production composition on native PostgreSQL", () => {
 const image = "ghcr.io/supabase/cli/postgres:17.11.0.006-r0@sha256:ee0f2d9747fb9d3c0a29703684ec718f070384ad05bf0d92823ed02cabde8e5a";
 const name = "embel-shared-composer-" + randomBytes(6).toString("hex"), env = { ...process.env };
 for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[key];
 let created = false, catalog: Record<string, unknown>, input: Record<string, unknown>;
 const docker = (args: string[], source?: string) => execFileSync("docker", ["--host=unix:///var/run/docker.sock", ...args], { env, input: source, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 20_000_000 }).trim();
 const sql = (source: string, role = "postgres") => docker(["exec", "-i", name, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", "/tmp", "-U", role, "-d", "postgres"], source);
 const readInventory = () => JSON.parse(sql(READ_ONLY_INVENTORY_SQL)) as Record<string, unknown>;
 const target = { projectRef: "fricsfwqibyhemknqgyf", origin: PRODUCTION_ORIGIN, issuer: PRODUCTION_ORIGIN + "/auth/v1" };
 beforeAll(async () => {
  docker(["image", "inspect", image, "--format", "{{.Id}}"]);
  docker(["run", "--detach", "--rm", "--pull=never", "--network=none", "--user=postgres", "--name=" + name, "--entrypoint=sh", image, "-c", "initdb -D /tmp/composer-fixture -U fixture_platform --auth=trust >/tmp/init.log && exec postgres -D /tmp/composer-fixture -k /tmp -c listen_addresses= -c shared_preload_libraries= -c log_statement=none -c log_min_error_statement=panic"]); created = true;
  for (let i = 0; i < 100; i++) { try { docker(["exec", name, "pg_isready", "-h", "/tmp", "-U", "fixture_platform", "-d", "postgres"]); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
  sql("create role postgres login nosuperuser noinherit createdb createrole noreplication bypassrls;grant pg_monitor to postgres with inherit true,set false;alter database postgres owner to postgres;create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant anon,authenticated,service_role to postgres with inherit false,set true;", "fixture_platform");
  sql(`create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean not null default false,banned_until timestamptz,deleted_at timestamptz);
   create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz);create table auth.refresh_tokens(session_id uuid,user_id text,revoked boolean default false);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
   create schema storage;create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text,unique(bucket_id,name));
   alter table storage.objects enable row level security;grant usage on schema storage to authenticated,service_role;grant select,insert,update,delete on storage.objects to authenticated,service_role;
   create function storage.operation() returns text language sql stable as $$select current_setting('storage.operation',true)$$;
   create function storage.allow_only_operation(expected_operation text) returns boolean language sql stable as $$select coalesce(regexp_replace(storage.operation(),'^storage\\.','')=regexp_replace(expected_operation,'^storage\\.',''),false)$$;`);
  // Pre-existing production baseline is reconstructed ONLY in this fixture.
  // The prepared production bundle contains none of these migrations/incidents.
  const names = readdirSync("supabase/migrations").filter(n => n.endsWith(".sql")).sort((a, b) => a.replace(/^local/, "").localeCompare(b.replace(/^local/, "")));
  for (const migration of names) sql(readFileSync("supabase/migrations/" + migration, "utf8"));
  for (const packet of ["candidates/logo_worker_storage.sql", "candidates/logo_generative_storage.sql", "candidates/logo_local_concepts.sql", "activation/logo_concepts_50_publication_adjudication.sql", "candidates/logo_local_refinements.sql"]) sql(readFileSync("supabase/" + packet, "utf8"));
  sql(`insert into auth.users(id,email_confirmed_at) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',clock_timestamp()),('cccccccc-cccc-4ccc-8ccc-cccccccccccc',clock_timestamp());
   create role fixture_legacy_logo login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   insert into fluid_private.logo_worker_principals select rolname,oid,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' from pg_roles where rolname='fixture_legacy_logo';
   insert into fluid_private.logo_storage_principals select 'cccccccc-cccc-4ccc-8ccc-cccccccccccc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',rolname,oid,'synthetic-legacy-worker',false from pg_roles where rolname='fixture_legacy_logo';`);
  expect(sql("select to_regprocedure('fluid_private.logo_production_storage_member(public.jobs,public.logo_asset_publications,text)') is null and to_regclass('fluid_private.logo_production_storage_capabilities') is null and to_regprocedure('public.authorize_logo_production_storage(uuid,uuid,uuid,text)') is null;")).toBe("t");
  catalog = readInventory(); input = { target, catalog };
 }, 90_000);
 afterAll(() => { if (created) docker(["rm", "--force", name]); });

 it("captures bounded predecessor hashes without invoking helper functions or reading private content", () => {
  const proof = JSON.parse(sql(READ_ONLY_PREREQUISITE_SQL));
  expect(proof.relations).toHaveLength(20); expect(proof.functions.length).toBeGreaterThan(10);
 });
 it("selects ten proven-missing packets and atomically rolls back every DDL/issuer/classification on a final failure", () => {
  const bundle = composeSharedProductionMigration(input); expect(bundle.packets).toEqual(PACKET_NAMES); expect(bundle.packets).toHaveLength(10);
  expect(bundle.sql).not.toContain("SOURCE logo_concepts_50_publication_adjudication.sql");
  expect(bundle.postInstallPackets).toEqual(POST_INSTALL_PACKETS);
  expect(bundle.sql.indexOf("-- POST-INSTALL shared_storage_download_metadata.sql")).toBeGreaterThan(bundle.sql.indexOf("-- SOURCE shared_identity_generation.sql"));
  expect(bundle.sql.indexOf("-- POST-INSTALL shared_logo_storage_member.sql")).toBeGreaterThan(bundle.sql.indexOf("-- POST-INSTALL shared_storage_download_metadata.sql"));
  expect(bundle.postInstallPackets.map(packet => packet.name)).toEqual(["shared_storage_download_metadata.sql", "shared_logo_storage_member.sql", "shared_naming_brainstorm.sql", "shared_naming_brainstorm_event_capacity.sql", "shared_logo_raster_uncapped.sql", "shared_logo_raster_recovery.sql", "shared_identity_selected_logo_boards.sql", "shared_identity_http_writer_permissions.sql", "shared_naming_brainstorm_delivery_recovery.sql", "shared_naming_lease_expiry.sql", "shared_guided_journey_stages.sql"]);
  expect(bundle.sql.indexOf("-- POST-INSTALL shared_naming_brainstorm_event_capacity.sql")).toBeGreaterThan(bundle.sql.indexOf("-- POST-INSTALL shared_naming_brainstorm.sql"));
  expect(bundle.sql.indexOf("-- POST-INSTALL shared_logo_raster_uncapped.sql")).toBeGreaterThan(bundle.sql.indexOf("-- POST-INSTALL shared_naming_brainstorm_event_capacity.sql"));
  expect(bundle.sql.indexOf("-- POST-INSTALL shared_logo_raster_recovery.sql")).toBeGreaterThan(bundle.sql.indexOf("-- POST-INSTALL shared_logo_raster_uncapped.sql"));
  for (const name of PACKET_NAMES) expect(bundle.sql).toContain(stripReviewedTransactionEnvelope(readFileSync("supabase/candidates/" + name, "utf8"), PACKET_SHA256[name]));
  expect(() => sql(bundle.sql.replace(/COMMIT;\n$/, "SELECT 1/0;\nCOMMIT;\n"))).toThrow();
  expect(readInventory()).toEqual(catalog);
  expect(sql("select to_regclass('fluid_private.shared_accounts') is null and not exists(select 1 from pg_policy where polname='embel_shared_customer_storage_live');")).toBe("t");
 });
 it("refuses target substitution, partial/unknown shared state, forged actor and incomplete identity proof", () => {
  expect(() => composeSharedProductionMigration({ ...input, target: { ...target, origin: "https://foreign.invalid" } })).toThrow("production_target_unqualified");
  expect(() => composeSharedProductionMigration({ ...input, catalog: { ...catalog, sharedObjects: [["relation", "fluid_private", "shared_accounts"]] } })).toThrow("existing_shared_install_unknown");
  expect(() => composeSharedProductionMigration({ ...input, catalog: { ...catalog, legacyActors: [{ authUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", proofSha256: "a".repeat(64), qualified: false }] } })).toThrow("legacy_actor_proof_unqualified");
  expect(() => composeSharedProductionMigration({ ...input, catalog: { ...catalog, identity: { ...(catalog.identity as object), relationPresent: true } } })).toThrow("existing_identity_requires_reviewed_complete_catalog_proof");
 });
 it("refuses an installed Identity prefix until complete guard equivalence is separately proved", () => {
  const source = readFileSync("supabase/candidates/identity_transactions.sql", "utf8"), body = stripReviewedTransactionEnvelope(source, PACKET_SHA256["identity_transactions.sql"]);
  const existing = JSON.parse(sql("BEGIN;\n" + body + "\n" + READ_ONLY_INVENTORY_SQL + "\nROLLBACK;"));
  expect(existing.identity.relationPresent).toBe(true);
  expect(() => composeSharedProductionMigration({ target, catalog: existing })).toThrow("existing_identity_requires_reviewed_complete_catalog_proof");
  expect(readInventory()).toEqual(catalog);
 });
 it("rejects a changed inventory before any candidate DDL is applied", () => {
  const bundle = composeSharedProductionMigration(input);
  sql("update fluid_private.logo_storage_principals set worker_id='changed-after-inventory';");
  expect(() => sql(bundle.sql)).toThrow();
  expect(sql("select to_regclass('fluid_private.shared_accounts') is null;")).toBe("t");
  sql("update fluid_private.logo_storage_principals set worker_id='synthetic-legacy-worker';");
 });
 it("exposes neither an empty-issuer fence nor misclassified legacy actors to a second connection", async () => {
  const bundle = composeSharedProductionMigration(input), gate = "shared_migration_ready_to_commit";
  const child = spawn("docker", ["--host=unix:///var/run/docker.sock", "exec", "-i", name, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", "/tmp", "-U", "postgres", "-d", "postgres"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.resume();
  const done = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  child.stdin.end(bundle.sql.replace(/COMMIT;\n$/, `SELECT '${gate}'; SELECT pg_sleep(2); COMMIT;\n`));
  for (let i = 0; i < 200 && !output.includes(gate); i++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(output.includes(gate)).toBe(true);
  expect(sql("select to_regclass('fluid_private.shared_http_target') is null and not exists(select 1 from pg_policy where polname='embel_shared_customer_storage_live');")).toBe("t");
  expect(await done).toBe(0);
  expect(sql("select exists(select 1 from pg_proc where oid=to_regprocedure('fluid_private.logo_production_storage_member(public.jobs,public.logo_asset_publications,text)') and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='4daa68465c9c0ed4cb36223d8348d3d1b78c2bb8c0cdff889eb4f567e5e3d0ee') and to_regclass('fluid_private.logo_production_storage_capabilities') is null and to_regprocedure('public.authorize_logo_production_storage(uuid,uuid,uuid,text)') is null;")).toBe("t");
  const readPolicies = JSON.parse(sql("select jsonb_agg(jsonb_build_object('name',polname,'expression',pg_get_expr(polqual,polrelid)) order by polname) from pg_policy where polrelid='storage.objects'::regclass and polname in('embel_shared_storage_read','embel_shared_storage_read_fence');"));
  expect(readPolicies).toHaveLength(2);
  for (const policy of readPolicies) { expect(policy.expression).toContain("object.get_authenticated_info"); expect(policy.expression).toContain("shared_storage_object_allowed"); }
  expect(sql(`select exists(select 1 from fluid_private.shared_http_target where singleton and mode='hosted' and origin='${PRODUCTION_ORIGIN}') and exists(select 1 from fluid_private.shared_storage_target where singleton and origin='${PRODUCTION_ORIGIN}') and exists(select 1 from fluid_private.shared_service_actors where auth_user_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc' and purpose='legacy_logo_storage') and exists(select 1 from pg_policy where polname='embel_shared_customer_storage_live');`)).toBe("t");
  expect(() => composeSharedProductionMigration({ target, catalog: readInventory() })).toThrow("existing_shared_install_unknown");
 }, 30_000);
});
