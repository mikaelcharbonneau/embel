import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedAccountFixture, sharedHttpRoles, type SharedAccountFixture } from "./shared-account-fixture";
import { OWNER_A, OWNER_B, seedProject } from "./local-supabase";
import { sharedHttpHelperHashes, qualifySharedHttpConnection } from "../../src/server/shared-account/qualification";
import { createSharedAccountHttpRuntime } from "../../src/server/shared-account/runtime";
import { readFileSync } from "node:fs";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { seedIdentityRoot } from "./identity-system-database";
import type { SharedAccountHttpDependencies } from "../../src/server/shared-account/runtime";
import { contextSnapshotSchema } from "../../src/domain/projects";

const hash = createHash("sha256").update("brief").digest("hex");
const upload = () => ({ requestKey: randomUUID(), name: "brief.txt", mimeType: "text/plain", contentHash: hash });
type Reservation = { ref: { id: string; ownerId: string }; verified: boolean };
describe("shared web authority actual restricted SQL (synthetic verified PostgREST sessions)", () => {
  let f: SharedAccountFixture;
  beforeAll(async () => { f = await createSharedAccountFixture(); }, 90_000);
  afterAll(async () => { await f?.db.close(); });

  it("installs exact helper bodies, no login defaults and zero direct customer grants", async () => {
    for (const [signature, hash] of Object.entries(sharedHttpHelperHashes)) {
      const body = (await f.db.query<{ body: string }>("select prosrc body from pg_proc where oid=to_regprocedure($1)", [signature])).rows[0]!.body;
      expect(createHash("sha256").update(body).digest("hex"), signature).toBe(hash);
    }
    for (const role of Object.values(sharedHttpRoles)) {
      expect((await f.db.query("select has_table_privilege($1,'public.projects','SELECT,INSERT,UPDATE,DELETE') allowed", [role])).rows).toEqual([{ allowed: false }]);
      await expect(f.asSession(role, () => f.db.query("select * from fluid_private.shared_http_requests"))).rejects.toMatchObject({ code: "42501" });
      await expect(f.asSession(role, () => f.db.exec("set role authenticated"))).rejects.toMatchObject({ code: "42501" });
      const oid = Number((await f.db.query<{ oid: number }>("select oid::int oid from pg_roles where rolname=$1", [role])).rows[0]!.oid);
      await f.asSession(role, () => qualifySharedHttpConnection({ query: (sql, args) => f.db.query(sql, [...(args ?? [])]), release() {}, discard() {} }, role === sharedHttpRoles.home ? "home" : "identity", { roleName: role, roleOid: oid, host: "inert", port: 5432, tls: true, user: role, password: "inert" }, "https://fricsfwqibyhemknqgyf.supabase.co"));
    }
  });

  it("one fixed verifier stages both tenants while scopes cannot change owner, arguments, lane or action", async () => {
    const input = upload(), args = [input, 5], cap = await f.issue(OWNER_A, "home", "prepare", args);
    expect(cap.ownerId).toBe(OWNER_A); expect(cap.token).toMatch(/^[a-f0-9]{64}$/u);
    const stored = (await f.db.query<{ token_hash: Uint8Array }>("select token_hash from fluid_private.shared_http_requests where token_hash=sha256(convert_to($1,'UTF8'))", [cap.token])).rows[0];
    expect(stored).toBeTruthy();
    await expect(f.asSession(sharedHttpRoles.identity, () => f.db.query("select public.execute_shared_home_request($1,'prepare',$2::jsonb,null)", [cap.token, JSON.stringify(args)]))).rejects.toMatchObject({ code: "42501" });
    await expect(f.asSession(sharedHttpRoles.home, () => f.db.query("select public.execute_shared_home_request($1,'prepare',$2::jsonb,null)", [cap.token, JSON.stringify([{ ...input, name: "changed" }, 5])]))).rejects.toMatchObject({ code: "42501" });
    const a = await f.asSession(sharedHttpRoles.home, async () => (await f.db.query<{ value: Reservation }>("select public.execute_shared_home_request($1,'prepare',$2::jsonb,null) value", [cap.token, JSON.stringify(args)])).rows[0]!.value);
    const b = await f.home(OWNER_B, "prepare", args) as Reservation;
    expect(a.ref.ownerId).toBe(OWNER_A); expect(b.ref.ownerId).toBe(OWNER_B); expect(a.ref.id).not.toBe(b.ref.id);
    await expect(f.issue(OWNER_B, "home", "readback", [a.ref.id])).rejects.toMatchObject({ code: "P0002" });
    await expect(f.asSession(sharedHttpRoles.home, () => f.db.query("select public.execute_shared_home_request($1,'prepare',$2::jsonb,null)", [cap.token, JSON.stringify(args)]))).rejects.toMatchObject({ code: "42501" });
    expect((await f.db.query("select count(*)::int count from fluid_private.shared_http_contexts")).rows).toEqual([{ count: 0 }]);
  });

  it("ordinary customers can delegate readback identity but cannot mint byte evidence or call the trusted verifier", async () => {
    const row = await f.home(OWNER_A, "prepare", [upload(), 5]) as Reservation;
    await expect(f.issue(OWNER_A, "home", "observe", [row.ref.id, { contentHash: hash, byteLength: 5, mimeType: "text/plain" }])).rejects.toMatchObject({ code: "22023" });
    await expect(f.issue(OWNER_A, "home", "readback", [row.ref.id, { contentHash: hash }])).rejects.toMatchObject({ code: "22023" });
    const cap = await f.issue(OWNER_A, "home", "readback", [row.ref.id]);
    await expect(f.asAuth(OWNER_A, () => f.db.query("select public.execute_shared_home_request($1,'readback',$2::jsonb,$3::jsonb)", [cap.token, JSON.stringify([row.ref.id]), JSON.stringify({ contentHash: hash, mimeType: "text/plain", byteLength: 5 })]))).rejects.toMatchObject({ code: "42501" });
    await expect(f.home(OWNER_A, "readback", [row.ref.id], { contentHash: hash, mimeType: "text/plain", byteLength: 6 })).rejects.toMatchObject({ code: "22023" });
    expect(await f.home(OWNER_A, "readback", [row.ref.id], { contentHash: hash, mimeType: "text/plain", byteLength: 5 })).toMatchObject({ ownerId: OWNER_A, id: row.ref.id });
  });

  it("checks real Auth eligibility, live sessions, expiry and registry OID at redemption", async () => {
    const args = [upload(), 5], cap = await f.issue(OWNER_A, "home", "prepare", args);
    await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1", [OWNER_A]);
    await expect(f.home(OWNER_A, "prepare", [upload(), 5])).rejects.toMatchObject({ code: "42501" });
    await expect(f.asSession(sharedHttpRoles.home, () => f.db.query("select public.execute_shared_home_request($1,'prepare',$2::jsonb,null)", [cap.token, JSON.stringify(args)]))).rejects.toMatchObject({ code: "42501" });
    await f.db.query("update auth.users set banned_until=null where id=$1", [OWNER_A]);
    await f.db.query("update fluid_private.shared_http_requests set expires_at=clock_timestamp()-interval '1 second' where token_hash=sha256(convert_to($1,'UTF8'))", [cap.token]);
    await expect(f.asSession(sharedHttpRoles.home, () => f.db.query("select public.execute_shared_home_request($1,'prepare',$2::jsonb,null)", [cap.token, JSON.stringify(args)]))).rejects.toMatchObject({ code: "42501" });
    const fresh = await f.issue(OWNER_A, "home", "prepare", args);
    await f.db.query("update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1", [f.sessions[OWNER_A]]);
    await expect(f.asSession(sharedHttpRoles.home, () => f.db.query("select public.execute_shared_home_request($1,'prepare',$2::jsonb,null)", [fresh.token, JSON.stringify(args)]))).rejects.toMatchObject({ code: "42501" });
    await f.db.query("update auth.sessions set not_after=null where id=$1", [f.sessions[OWNER_A]]);
    await expect(f.asAuth(OWNER_A, () => f.db.query("select public.issue_shared_account_request('home','prepare',$1)", [JSON.stringify(args)]), { session_id: f.sessions[OWNER_B] })).rejects.toMatchObject({ code: "42501" });
  });

  it("unconfirmed customers, service actors and forged/expired session claims cannot issue authority", async () => {
    for (const mutation of ["update auth.users set email_confirmed_at=null where id=$1", "insert into fluid_private.shared_service_actors(auth_user_id,purpose) values($1,'logo_storage')"]) {
      await f.db.exec("begin");
      try { await f.db.query(mutation, [OWNER_A]); await expect(f.issue(OWNER_A, "home", "prepare", [upload(), 5])).rejects.toMatchObject({ code: "42501" }); }
      finally { await f.db.exec("rollback"); }
    }
    for (const override of [{ exp: 1 }, { iss: "https://foreign.example/auth/v1" }, { is_anonymous: true }, { role: "service_role" }])
      await expect(f.asAuth(OWNER_A, () => f.db.query("select public.issue_shared_account_request('home','prepare',$1)", [JSON.stringify([upload(), 5])]), override)).rejects.toMatchObject({ code: "42501" });
  });

  it("actual OID and membership changes invalidate delegated authority without granting arbitrary owner access", async () => {
    const cap = await f.issue(OWNER_A, "home", "prepare", [upload(), 5]);
    await f.db.exec("begin");
    try {
      await f.db.exec("update fluid_private.shared_http_principals set role_oid=1 where lane='home'");
      await expect(f.asSession(sharedHttpRoles.home, () => f.db.query("select public.shared_account_http_principal()"))).rejects.toMatchObject({ code: "42501" });
    } finally { await f.db.exec("rollback"); }
    await f.db.exec("begin");
    try {
      await f.db.exec(`grant authenticated to ${sharedHttpRoles.home}`);
      await expect(f.asSession(sharedHttpRoles.home, () => f.db.query("select public.shared_account_http_principal()"))).rejects.toMatchObject({ code: "42501" });
      expect(cap.token).toHaveLength(64);
    } finally { await f.db.exec("rollback"); }
  });

  it("arbitrary GUC owner claims and missing delegation never authorize Identity", async () => {
    const project = await seedProject(f.db, OWNER_A);
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_A]);
    await expect(f.asSession(sharedHttpRoles.identity, () => f.db.query("select public.prepare_shared_identity_request($1,$2,'{}',false)", ["a".repeat(64), project.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(f.asSession(sharedHttpRoles.identity, () => f.db.query("select public.commit_shared_identity_request($1,'{}','{}')", [project.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(f.issue(OWNER_B, "identity", "identity", [project.id, {}, false])).rejects.toMatchObject({ code: "P0002" });
  });

  it("ban/unban cannot resurrect an earlier ownership delegation", async () => {
    const args = [upload(), 5], cap = await f.issue(OWNER_A, "home", "prepare", args);
    await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1", [OWNER_A]);
    await f.db.query("update auth.users set banned_until=null where id=$1", [OWNER_A]);
    await expect(f.asSession(sharedHttpRoles.home, () => f.db.query("select public.execute_shared_home_request($1,'prepare',$2::jsonb,null)", [cap.token, JSON.stringify(args)]))).rejects.toMatchObject({ code: "42501" });
    expect(await f.home(OWNER_A, "prepare", args)).toMatchObject({ ref: { ownerId: OWNER_A } });
  });

  it("unexpected function ownership, database CREATE, sequence or generic mutation EXEC fails role qualification", async () => {
    for (const grant of [
      `grant create on database postgres to ${sharedHttpRoles.home}`,
      `grant usage on schema fluid_private to ${sharedHttpRoles.home}`,
      `create sequence public.shared_http_fixture_sequence;grant usage on sequence public.shared_http_fixture_sequence to ${sharedHttpRoles.home}`,
      `create function public.shared_http_fixture_owned() returns integer language sql as 'select 1';alter function public.shared_http_fixture_owned() owner to ${sharedHttpRoles.home}`,
      `grant execute on function public.create_project(text,text,jsonb,text) to ${sharedHttpRoles.home}`,
    ]) {
      await f.db.exec("begin");
      try { await f.db.exec(grant); await expect(f.asSession(sharedHttpRoles.home, () => f.db.query("select public.shared_account_http_principal()"))).rejects.toMatchObject({ code: "42501" }); }
      finally { await f.db.exec("rollback"); }
    }
  });

  function runtime(lostCommit = false, storage?: Map<string, Uint8Array>) {
    const oid = async (role: string) => Number((await f.db.query<{ oid: number }>("select oid::int oid from pg_roles where rolname=$1", [role])).rows[0]!.oid);
    const dependencies: SharedAccountHttpDependencies = {
      readCertificate: () => readFileSync(new URL("../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8"),
      fetch: async (input, init) => {
        if (!storage || typeof input !== "string") throw Error("No external HTTP in SQL fixtures");
        if (init?.method === "POST") {
          if (storage.has(input)) return Response.json({ code: "ResourceAlreadyExists" }, { status: 409 });
          storage.set(input, new Uint8Array(init.body as Uint8Array));
          return Response.json({ Id: randomUUID(), Key: input.split("/storage/v1/object/")[1] });
        }
        const bytes = storage.get(input); return bytes ? new Response(new Uint8Array(bytes).buffer, { headers: { "content-type": "text/plain" } }) : new Response(null, { status: 404 });
      },
      createPool: options => ({ on: () => {}, async end() {}, async connect() {
        await f.db.exec(`set session authorization ${options.user}`);
        return { on: () => {}, removeListener: () => {}, async end() {}, release() { void f.db.exec("reset role;set session authorization postgres"); }, async query(input) {
          const result = await f.db.query(input.text, input.values);
          if (lostCommit && input.text === "COMMIT") throw Error("Synthetic lost COMMIT ACK after real SQL commit");
          return result;
        } };
      } }),
    };
    return { async create() { return createSharedAccountHttpRuntime({ EMBEL_SHARED_ACCOUNT_HTTP_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "https://fricsfwqibyhemknqgyf.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_inertfixture",
      EMBEL_SHARED_ACCOUNT_HTTP_CONFIG: JSON.stringify({ identity: { roleName: sharedHttpRoles.identity, roleOid: await oid(sharedHttpRoles.identity), databaseUrl: `postgresql://${sharedHttpRoles.identity}:inertfixture@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full` },
        ...(storage ? { homeVerifier: { roleName: sharedHttpRoles.home, roleOid: await oid(sharedHttpRoles.home), databaseUrl: `postgresql://${sharedHttpRoles.home}:inertfixture@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full` } } : {}) }) }, dependencies)!; } };
  }
  function auth(owner: string): AuthenticatedContext {
    const user = { id: owner, is_anonymous: false, email_confirmed_at: "2026-10-01T00:00:00Z" };
    return { userId: owner, client: { auth: { getSession: async () => ({ data: { session: { user, access_token: `inert.${owner}.token` } }, error: null }), getUser: async () => ({ data: { user }, error: null }) }, async rpc(name: string, args: Record<string, unknown>) {
      if (!["issue_shared_account_request", "save_attached_home_project", "read_attached_home_project_request"].includes(name)) throw Error("Unexpected fixture RPC");
      const previous = (await f.db.query<{ role: string }>("select session_user::text role")).rows[0]!.role;
      try {
        const result = await f.asAuth(owner, () => name === "issue_shared_account_request"
          ? f.db.query<{ value: unknown }>("select public.issue_shared_account_request($1,$2,$3::jsonb) value", [args.p_lane, args.p_action, JSON.stringify(args.p_arguments)])
          : f.db.query<{ value: unknown }>(`select public.${name}(${Object.keys(args).map((_, i) => `$${i + 1}`).join(",")}) value`, Object.values(args).map(value => typeof value === "object" ? JSON.stringify(value) : value)));
        return { data: result.rows[0]!.value, error: null };
      } catch (error) { return { data: null, error }; }
      finally { await f.db.exec(`set session authorization ${previous}`); }
    } } } as unknown as AuthenticatedContext;
  }

  it("normal shared Home path validates bytes, persists private reservations and saves/replays two customers with fixed verifier", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fricsfwqibyhemknqgyf.supabase.co"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_inertfixture");
    const objects = new Map<string, Uint8Array>(), shared = await runtime(false, objects).create();
    try {
      for (const owner of [OWNER_A, OWNER_B]) {
        const lease = await shared.acquireHome(auth(owner)); expect(lease.value).not.toBeNull();
        const input = upload(), attachment = await lease.value!.stageHomeAttachment(auth(owner), { ...input, mimeType: "text/plain" }, new TextEncoder().encode("brief"));
        expect(attachment.ownerId).toBe(owner);
        const draft = { requestKey: randomUUID(), project: { title: "Shared verifier fixture", scope: "complete_brand" as const, context: contextSnapshotSchema.parse({ description: "Actual SQL with inert Storage transport" }) }, attachmentIds: [attachment.id] };
        const saved = await lease.value!.saveAttachedProjectDraft(auth(owner), draft);
        expect(saved.ownerId).toBe(owner); expect(saved.attachments[0]!.id).toBe(attachment.id);
        expect(await lease.value!.saveAttachedProjectDraft(auth(owner), draft)).toEqual(saved);
        await lease.release();
      }
      expect(objects.size).toBe(2);
    } finally { await shared.close(); vi.unstubAllEnvs(); }
  });

  it("normal shared runtime performs real Identity selection/refinement and exact replay for two users on one fixed login", async () => {
    const shared = await runtime().create();
    try {
      for (const owner of [OWNER_A, OWNER_B]) {
        await f.db.exec("set session authorization postgres");
        const project = await seedProject(f.db, owner), root = await seedIdentityRoot(f.db, project.id, { ownerId: owner });
        const request = { systemVersionId: root.system.id, expectedProjectRevision: root.input.projectRevision, expectedReferenceRevision: root.input.referenceSnapshot.referenceRevision, expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: true };
        const lease = await shared.acquireIdentity(auth(owner)); expect(lease.value).not.toBeNull();
        const selection = await lease.value!.transactions.select(auth(owner), project.id, request);
        expect(selection.currentSelection.selection.ownerId).toBe(owner);
        const refinement = { baseSystemVersionId: root.system.id, component: "colors", input: { swatches: [{ key: "primary", name: "New", hex: "#ABCDEF" }], usageNotes: "" }, idempotencyKey: `shared-http-refinement-${owner}`,
          expectedProjectRevision: request.expectedProjectRevision, expectedReferenceRevision: request.expectedReferenceRevision, expectedPreferencesRevision: 0, expectedIdentityRevision: 1, acceptEarlierBasis: true };
        const refined = await lease.value!.transactions.refine(auth(owner), project.id, refinement);
        const replay = await lease.value!.transactions.refine(auth(owner), project.id, refinement);
        expect(replay).toEqual(refined); expect(refined.system.ownerId).toBe(owner);
        await lease.release();
        await f.db.exec("set session authorization postgres");
        expect((await f.db.query("select count(*)::int count from fluid_private.shared_http_contexts")).rows).toEqual([{ count: 0 }]);
      }
    } finally { await shared.close(); }
  });

  it("lost real SQL COMMIT acknowledgement preserves selection and requires uncertain-commit reconciliation", async () => {
    await f.db.exec("set session authorization postgres");
    const project = await seedProject(f.db, OWNER_A), root = await seedIdentityRoot(f.db, project.id);
    const shared = await runtime(true).create(), lease = await shared.acquireIdentity(auth(OWNER_A));
    expect(lease.value).not.toBeNull();
    await expect(lease.value!.transactions.select(auth(OWNER_A), project.id, { systemVersionId: root.system.id, expectedProjectRevision: root.input.projectRevision, expectedReferenceRevision: root.input.referenceSnapshot.referenceRevision, expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: true })).rejects.toMatchObject({ name: "IdentityUncertainCommitError", recovery: { action: "read_before_explicit_retry" } });
    await f.db.exec("set session authorization postgres");
    expect((await f.db.query("select count(*)::int count from public.identity_selections where project_id=$1", [project.id])).rows).toEqual([{ count: 1 }]);
    expect((await f.db.query("select count(*)::int count from fluid_private.shared_http_contexts")).rows).toEqual([{ count: 0 }]);
    await shared.close();
  });

  it("COMMIT without explicit private context cleanup is rejected, and rollback permits exact capability retry", async () => {
    const project = await seedProject(f.db, OWNER_A), root = await seedIdentityRoot(f.db, project.id);
    const request = { systemVersionId: root.system.id, expectedProjectRevision: root.input.projectRevision, expectedReferenceRevision: root.input.referenceSnapshot.referenceRevision, expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: true };
    const cap = await f.issue(OWNER_A, "identity", "identity", [project.id, request, false]);
    await f.db.exec(`set session authorization ${sharedHttpRoles.identity};begin`);
    await f.db.query("select public.prepare_shared_identity_request($1,$2,$3::jsonb,false)", [cap.token, project.id, JSON.stringify(request)]);
    await expect(f.db.exec("commit")).rejects.toMatchObject({ code: "55000" });
    await f.db.exec("rollback;set session authorization postgres");
    expect((await f.db.query("select consumed from fluid_private.shared_http_requests where token_hash=sha256(convert_to($1,'UTF8'))", [cap.token])).rows).toEqual([{ consumed: false }]);
    expect((await f.db.query("select count(*)::int count from fluid_private.shared_http_contexts")).rows).toEqual([{ count: 0 }]);
    await f.db.exec(`set session authorization ${sharedHttpRoles.identity};begin`);
    await f.db.query("select public.prepare_shared_identity_request($1,$2,$3::jsonb,false)", [cap.token, project.id, JSON.stringify(request)]);
    await f.db.query("select public.finish_shared_identity_request()");
    await f.db.exec("commit;set session authorization postgres");
  });

  it("unregistered legacy logins retain their independent SQL owner binding and reject spoofed claims", async () => {
    const role = "fixture_shared_legacy_identity";
    await f.db.exec(`create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to ${role}; grant execute on function fluid_private.prepare_identity_transaction(uuid,jsonb,boolean) to ${role};
      insert into fluid_private.identity_web_principals(login_role_oid,login_role_name,owner_id) select oid,rolname,'${OWNER_A}' from pg_roles where rolname='${role}';`);
    const project = await seedProject(f.db, OWNER_A), root = await seedIdentityRoot(f.db, project.id);
    const request = { systemVersionId: root.system.id, expectedProjectRevision: root.input.projectRevision, expectedReferenceRevision: root.input.referenceSnapshot.referenceRevision, expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: true };
    await f.db.exec(`set session authorization ${role};begin`);
    try {
      await f.db.query("select set_config('request.jwt.claim.sub',$1,true)", [OWNER_A]);
      const result = await f.db.query<{ value: { ownerId: string } }>("select fluid_private.prepare_identity_transaction($1,$2::jsonb,false) value", [project.id, JSON.stringify(request)]);
      expect(result.rows[0]!.value.ownerId).toBe(OWNER_A);
    } finally { await f.db.exec("rollback;set session authorization postgres"); }
    await f.db.exec(`set session authorization ${role};begin`);
    try {
      await f.db.query("select set_config('request.jwt.claim.sub',$1,true)", [OWNER_B]);
      await expect(f.db.query("select fluid_private.prepare_identity_transaction($1,$2::jsonb,false)", [project.id, JSON.stringify(request)])).rejects.toMatchObject({ code: "42501" });
    } finally { await f.db.exec("rollback;set session authorization postgres"); }
  });

  it("commit rechecks the exact eligibility epoch, while ordinary callers cannot mutate it", async () => {
    const project = await seedProject(f.db, OWNER_A), root = await seedIdentityRoot(f.db, project.id);
    const request = { systemVersionId: root.system.id, expectedProjectRevision: root.input.projectRevision, expectedReferenceRevision: root.input.referenceSnapshot.referenceRevision, expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: true };
    const cap = await f.issue(OWNER_A, "identity", "identity", [project.id, request, false]);
    await f.db.exec(`set session authorization ${sharedHttpRoles.identity};begin`);
    await f.db.query("select public.prepare_shared_identity_request($1,$2,$3::jsonb,false)", [cap.token, project.id, JSON.stringify(request)]);
    // Trusted fixture fault only: another normal transaction is fenced by the held Auth/account SHARE locks.
    await f.db.exec("set session authorization postgres");
    await f.db.query("update fluid_private.shared_accounts set eligibility_epoch=eligibility_epoch+1 where owner_id=$1", [OWNER_A]);
    await f.db.exec(`set session authorization ${sharedHttpRoles.identity}`);
    try { await expect(f.db.query("select public.commit_shared_identity_request($1,$2::jsonb,'{}')", [project.id, JSON.stringify(request)])).rejects.toMatchObject({ code: "42501" }); }
    finally { await f.db.exec("rollback;set session authorization postgres"); }
    await expect(f.asSession(sharedHttpRoles.identity, () => f.db.query("update fluid_private.shared_accounts set eligibility_epoch=eligibility_epoch+1"))).rejects.toMatchObject({ code: "42501" });
  });
});
