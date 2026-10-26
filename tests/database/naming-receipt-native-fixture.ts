import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { fixtureMigrationNames } from "./fixture-migrations";
import { installStorageOperationFixture, type TestDatabase } from "./local-supabase";

/** Explicit opt-in to a reviewer-provisioned disposable PostgreSQL cluster.
 * The private file is never copied, printed, or included in test diagnostics.
 * This harness owns only its unique database/roles, not the server lifecycle. */
export const receiptNativeConfigPath = process.env.EMBEL_RECEIPT_NATIVE_CONFIG;
export async function createReceiptNativeFixture(options: { before?: string } = {}) {
  if (!receiptNativeConfigPath) throw new Error("native_receipt_config_required");
  const metadata = await stat(receiptNativeConfigPath);
  if (!metadata.isFile() || metadata.mode & 0o077 || metadata.uid !== process.getuid?.()) throw new Error("native_receipt_config_must_be_private");
  const configuration = JSON.parse(await readFile(receiptNativeConfigPath, "utf8")) as Record<string, unknown>;
  if (configuration.disposableCluster !== true || configuration.host !== "127.0.0.1"
    || !Number.isInteger(configuration.port) || Number(configuration.port) < 1024 || Number(configuration.port) > 65535
    || typeof configuration.user !== "string" || !/^[a-zA-Z0-9_]+$/.test(configuration.user)
    || configuration.password !== undefined && typeof configuration.password !== "string"
    || typeof configuration.expectedDataDirectory !== "string" || !configuration.expectedDataDirectory
    || typeof configuration.expectedClusterName !== "string" || !configuration.expectedClusterName
    || configuration.database !== "postgres") throw new Error("native_receipt_disposable_loopback_required");
  const connection = { host: "127.0.0.1", port: Number(configuration.port), user: configuration.user,
    ...(typeof configuration.password === "string" ? { password: configuration.password } : {}),
    connectionTimeoutMillis: 5000, application_name: "embel-receipt-native-test" };
  const database = `receipt_${process.pid}_${Date.now()}`;
  const aliases = { fixture_naming_brain_a: `${database}_a`, fixture_naming_brain_b: `${database}_b`,
    fixture_subscription_worker_a: `${database}_subscription_a`, fixture_subscription_worker_b: `${database}_subscription_b` };
  const rewrite = (sql: string) => {
    let text = sql.replaceAll("set session authorization postgres", "reset session authorization");
    for (const [key, value] of Object.entries(aliases)) text = text.replaceAll(key, value);
    return text;
  };
  const admin = new Client({ ...connection, database: "postgres" });
  // Raw connection errors may retain private configuration; report a fixed code.
  try { await admin.connect(); } catch { await admin.end().catch(() => {}); throw new Error("native_receipt_connection_unavailable"); }
  const identity = (await admin.query(`select host(inet_server_addr()) host,inet_server_port() port,
    current_setting('server_version_num') version,current_setting('data_directory') directory,current_setting('cluster_name') cluster,
    current_setting('fsync') fsync,current_setting('full_page_writes') full_page_writes,
    current_setting('synchronous_commit') synchronous_commit,current_setting('wal_level') wal_level`)).rows[0];
  const version = Number(identity.version);
  if (version < 180000 || version >= 190000 || identity.host !== configuration.host || identity.port !== configuration.port
    || identity.directory !== configuration.expectedDataDirectory || identity.cluster !== configuration.expectedClusterName
    || identity.fsync !== "on" || identity.full_page_writes !== "on" || identity.synchronous_commit !== "on" || identity.wal_level !== "replica") {
    await admin.end(); throw new Error("native_receipt_cluster_identity_or_durability_mismatch");
  }
  const rolesBefore = new Set((await admin.query<{ rolname: string }>("select rolname from pg_roles")).rows.map(row => row.rolname));
  const setup = new Client({ ...connection, database });
  const opened = [setup];
  let initialized = false, initializationStage = "database_create", closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Disconnect rolls back an open transaction. Do not queue ROLLBACK on a
    // client whose connect/create step failed: it may never become queryable.
    await Promise.all(opened.map(client => client.end().catch(() => {})));
    try {
      const created = (await admin.query<{ rolname: string }>("select rolname from pg_roles")).rows.map(row => row.rolname)
        .filter(role => !rolesBefore.has(role) && (Object.values(aliases).includes(role) || ["anon", "authenticated", "service_role", "fluid_identity_writer_definer_v1"].includes(role)));
      const manifestDirectory = new URL("../../.tmp/", import.meta.url);
      await mkdir(manifestDirectory, { recursive: true });
      await writeFile(new URL(`native-receipt-${database}.json`, manifestDirectory), JSON.stringify({
        fixturePreserved: true, database, createdRoles: created, version, initialized, initializationStage,
        durability: { fsync: identity.fsync, fullPageWrites: identity.full_page_writes, synchronousCommit: identity.synchronous_commit, walLevel: identity.wal_level },
      }, null, 2), { mode: 0o600 });
    } finally { await admin.end().catch(() => {}); }
  };
  try {
  await admin.query(`create database ${database}`);
  initializationStage = "fixture_connect";
  await setup.connect();
  const db = { exec: (sql: string) => setup.query(rewrite(sql)), query: (sql: string, values?: unknown[]) =>
    setup.query(rewrite(sql), values?.map(value => typeof value === "string" ? rewrite(value) : value)) } as unknown as TestDatabase;
  await setup.query("set statement_timeout='30s'");
  initializationStage = "fixture_bootstrap";
  await db.exec(`
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
      if not exists(select 1 from pg_roles where rolname='fluid_identity_writer_definer_v1') then
        create role fluid_identity_writer_definer_v1 nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
    end $$;
    create role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role fixture_subscription_worker_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated,service_role;
    grant select,insert,update,delete on storage.objects to authenticated,service_role;
  `);
  await installStorageOperationFixture(db);
  const directory = new URL("../../supabase/migrations/", import.meta.url);
  let predecessorDefinition: string | undefined;
  for (const name of fixtureMigrationNames(await readdir(directory), options.before)) {
    initializationStage = name;
    if (name === "20261026153000_naming_receipt_semantic_state.sql") predecessorDefinition =
      (await setup.query("select pg_get_functiondef('public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)'::regprocedure) definition")).rows[0].definition;
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  }
  const connectWorker = async () => {
    const client = new Client({ ...connection, database }); opened.push(client); await client.connect();
    await client.query("set statement_timeout='15s'");
    await client.query(`set session authorization ${aliases.fixture_naming_brain_a}`);
    return client;
  };
  initialized = true; initializationStage = "ready";
  return { db, setup, connectWorker, version, database, predecessorDefinition, close };
  } catch (error) {
    await close();
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable";
    throw new Error(`native_receipt_fixture_initialization_failed:${initializationStage}:${code}`);
  }
}
