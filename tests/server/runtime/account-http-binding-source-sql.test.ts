import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolConfig } from "pg";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { IdentityPoolClientPort } from "@/server/runtime/identity-pool";
import type { EnrollmentHttpBinding } from "@/server/account-enrollment/contracts";
vi.mock("server-only", () => ({}));
import { createAccountEnrollmentFixture } from "../../database/account-enrollment-fixture";
import { asRole } from "../../database/local-supabase";
import { createSqlEnrollmentStore } from "@/server/account-enrollment/sql-store";
import { createAccountHttpBindingSourceRuntime } from "@/server/runtime/account-http-binding-source";
import { createAccountHttpRuntimeFromConfiguration } from "@/server/runtime/account-http-services";

const owners = ["ab100000-0000-4000-8000-000000000001", "ab100000-0000-4000-8000-000000000002"] as const;
const foreignOwner = "ab100000-0000-4000-8000-000000000003";
const cert = readFileSync(new URL("../../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8");
const salt = Buffer.alloc(16, 37), salted = pbkdf2Sync("disposable-fixture-only", salt, 4096, 32, "sha256");
const verifier = `SCRAM-SHA-256$4096:${salt.toString("base64")}$${createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest("base64")}:${createHmac("sha256", salted).update("Server Key").digest("base64")}`;
type Publication = { ownerId: string; generation: number; revision: number; identity?: { publicationReceipt: string; configuration: unknown }; attachments?: { publicationReceipt: string; configuration: unknown } };

describe("dynamic publication composition through real owner-derived SQL and actual managed principals (PGlite provider-schema fixture)", () => {
  let fixture: Awaited<ReturnType<typeof createAccountEnrollmentFixture>>;
  let runtime: ReturnType<typeof createAccountHttpBindingSourceRuntime>;
  const publications = new Map<string, Publication>(), bindings = new Map<string, EnrollmentHttpBinding[]>();
  const checkouts: string[] = [], tokenSelections: string[] = [], ended: string[] = [];
  const source = { read: vi.fn(async (ownerId: string) => publications.get(ownerId) ?? null) };
  function pool(configuration: PoolConfig) {
    const role = configuration.user!;
    const client = Object.assign(new EventEmitter(), {
      async query(input: Parameters<IdentityPoolClientPort["query"]>[0]) { return fixture.db.query(input.text, input.values); },
      release() {}, async end() {},
    });
    return Object.assign(new EventEmitter(), {
      async connect() { checkouts.push(role); await fixture.db.exec("set session authorization postgres"); await fixture.db.exec(`set session authorization "${role}"`); return client; },
      async end() { ended.push(role); },
    });
  }
  async function enroll(owner: string) {
    await fixture.seedUser(owner);
    const store = createSqlEnrollmentStore(fixture.operator); let claim = (await store.claim())!;
    expect(claim.ownerId).toBe(owner);
    const record: Publication = { ownerId: owner, generation: claim.generation, revision: claim.revision };
    const prepared: EnrollmentHttpBinding[] = [];
    for (const capability of ["home_attachments", "identity_transactions"] as const) {
      const step = claim.steps.find(step => step.capability === capability)!;
      claim = await store.record(claim, capability, "provisioning");
      const reference = `synthetic-fixture:${step.operationKey}`;
      claim = await store.record(claim, capability, "credential_reserved", reference);
      const binding = await store.provisionHttp(claim, capability, { reference, verifier }); prepared.push(binding);
      const publicationReceipt = `synthetic-publication:${step.operationKey}`;
      claim = await store.record(claim, capability, "published", publicationReceipt);
      claim = await store.record(claim, capability, "ready", `qualified:${step.operationKey}`);
      const { ownerId: _owner, credentialRef: _ref, ...metadata } = binding; void _owner; void _ref;
      record[capability === "home_attachments" ? "attachments" : "identity"] = { publicationReceipt,
        configuration: { ...metadata, databaseUrl: `postgresql://${binding.roleName}:synthetic-fixture-only@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full` } };
    }
    for (const capability of ["strategy", "naming", "logo"] as const) claim = await store.record(claim, capability, "blocked", "adapter_unavailable");
    expect((await store.finish(claim)).status).toBe("pending"); publications.set(owner, record); bindings.set(owner, prepared);
  }
  function auth(owner: string): AuthenticatedContext {
    const user = { id: owner, is_anonymous: false, email_confirmed_at: "2026-10-01T00:00:00Z" };
    return { userId: owner, client: {
      rpc: vi.fn(async (name: string) => {
        expect(name).toBe("get_account_service_enrollment_binding");
        try {
          const data = await fixture.admin(() => asRole(fixture.db, "authenticated", owner,
            async () => (await fixture.db.query<{ value: unknown }>("select public.get_account_service_enrollment_binding() value")).rows[0]!.value));
          return { data, error: null };
        } catch { return { data: null, error: { code: "42501", message: "account_enrollment_unauthenticated" } }; }
      }),
      auth: { getSession: vi.fn(async () => { tokenSelections.push(owner); return { data: { session: { user, access_token: `synthetic-${owner}` } }, error: null }; }),
        getUser: vi.fn(async () => ({ data: { user }, error: null })) },
    } } as unknown as AuthenticatedContext;
  }
  beforeAll(async () => {
    fixture = await createAccountEnrollmentFixture(); await enroll(owners[0]); await enroll(owners[1]); await fixture.seedUser(foreignOwner, { confirmed: false });
    runtime = createAccountHttpBindingSourceRuntime({ source, publishableKey: "sb_publishable_synthetic_managed_http", capacity: 2,
      createRuntime: configuration => createAccountHttpRuntimeFromConfiguration(configuration, { createPool: pool, readCertificate: () => cert, fetch: vi.fn() }) });
  }, 60_000);
  afterAll(async () => { await runtime?.close(); await fixture?.close(); });
  it("qualifies both HTTP lanes for two enrolled owners with their exact actual managed role/OID and retained manager edge", async () => {
    for (const owner of owners) {
      const identity = await runtime.acquireIdentity(auth(owner)); expect(identity.value?.saveAvailability.status).toBe("available"); await identity.release();
      const home = await runtime.acquireHome(auth(owner)); expect(home.value?.getHomeAttachmentCapability()?.allowedMimeTypes).toContain("text/plain"); await home.release();
      expect(checkouts).toContain(bindings.get(owner)![0]!.roleName); expect(checkouts).toContain(bindings.get(owner)![1]!.roleName);
    }
    expect(tokenSelections).toEqual([...owners]); expect(fixture.db.isInTransaction()).toBe(false);
  });
  it("rejects foreign publication before checkout or Home token retrieval", async () => {
    const original = publications.get(owners[0])!; publications.set(owners[0], publications.get(owners[1])!);
    const count = checkouts.length, tokens = tokenSelections.length;
    expect((await runtime.acquireHome(auth(owners[0]))).value).toBeNull(); expect(checkouts).toHaveLength(count); expect(tokenSelections).toHaveLength(tokens);
    expect(ended).toContain(bindings.get(owners[0])![0]!.roleName); publications.set(owners[0], original);
  });
  it("rejects a foreign actual database binding even when publication metadata and Auth match", async () => {
    const identityRole = bindings.get(owners[1])!.find(binding => binding.capability === "identity_transactions")!.roleName;
    await fixture.admin(async () => { await fixture.db.query("update fluid_private.identity_web_principals set owner_id=$1 where login_role_name=$2", [foreignOwner, identityRole]); });
    const lease = await runtime.acquireIdentity(auth(owners[1])); expect(lease.value).toBeNull(); expect(fixture.db.isInTransaction()).toBe(false); expect(ended).toContain(identityRole);
    await fixture.admin(async () => { await fixture.db.query("update fluid_private.identity_web_principals set owner_id=$1 where login_role_name=$2", [owners[1], identityRole]); });
  });
  it("rejects an explicitly public-role executable managed proof and cleans the qualification transaction", async () => {
    await fixture.admin(async () => { await fixture.db.exec("grant execute on function public.account_enrollment_managed_principal() to anon"); });
    try {
      expect((await runtime.acquireIdentity(auth(owners[1]))).value).toBeNull();
      expect(fixture.db.isInTransaction()).toBe(false);
    } finally { await fixture.admin(async () => { await fixture.db.exec("revoke execute on function public.account_enrollment_managed_principal() from anon"); }); }
    const restored = await runtime.acquireIdentity(auth(owners[1])); expect(restored.value).not.toBeNull(); await restored.release();
  });
  it("uses actual Auth ban state to reject stale publication before external lookup, checkout or token selection", async () => {
    const first = await runtime.acquireIdentity(auth(owners[0])); expect(first.value).not.toBeNull(); await first.release();
    await fixture.admin(async () => { await fixture.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [owners[0]]); });
    source.read.mockClear(); const count = checkouts.length, tokens = tokenSelections.length;
    expect((await runtime.acquireHome(auth(owners[0]))).value).toBeNull(); expect(source.read).not.toHaveBeenCalled(); expect(checkouts).toHaveLength(count); expect(tokenSelections).toHaveLength(tokens);
  });
});
