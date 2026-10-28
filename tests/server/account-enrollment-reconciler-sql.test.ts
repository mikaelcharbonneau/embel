import { createHash, createHmac, pbkdf2Sync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createAccountEnrollmentFixture } from "../database/account-enrollment-fixture";
import { createSqlEnrollmentStore } from "@/server/account-enrollment/sql-store";
import { reconcileAccountEnrollmentOnce } from "@/server/account-enrollment/reconciler";
import { createHttpEnrollmentAdapter } from "@/server/account-enrollment/http-adapter";
import { EnrollmentEffectUnavailable, type EnrollmentBindingPublisher, type EnrollmentContext, type EnrollmentCredentialStore,
  type EnrollmentHttpBinding, type EnrollmentPublication } from "@/server/account-enrollment/contracts";
import type { IdentityConnectionFactory } from "@/server/data/identity-transaction";

/** Synthetic durable-store fixture only. No credential file, external vault,
 * Auth service, Storage service or production principal is configured here. */
function scram(operation: string) {
  const salt = createHash("sha256").update(operation).digest().subarray(0, 16);
  const salted = pbkdf2Sync(`synthetic-disposable:${operation}`, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

describe("leased enrollment orchestration over real restricted SQL (PGlite provider-schema fixture)", () => {
  let fixture: Awaited<ReturnType<typeof createAccountEnrollmentFixture>>;
  beforeAll(async () => { fixture = await createAccountEnrollmentFixture(); }, 60_000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    // Keep prior managed-role evidence: removing it would correctly invalidate
    // the manager's retained ADMIN-only child-role proof. Only retire old work.
    await fixture.admin(async () => { await fixture.db.exec("update fluid_private.account_service_enrollments set available_at='infinity',lease_token=null,lease_until=null,lease_role_name=null,lease_role_oid=null"); });
  });
  function ports() {
    const reservations = new Map<string, { reference: string; verifier: string; owner: string }>();
    const publications = new Map<string, EnrollmentPublication>();
    const reservedKeys: string[] = [], bindings: EnrollmentHttpBinding[] = [];
    const credentials: EnrollmentCredentialStore = {
      async reserve(context) {
        const key = context.step.operationKey; reservedKeys.push(key);
        if (!reservations.has(key)) reservations.set(key, { reference: `fixture-secret:${key}`, verifier: scram(key), owner: context.claim.ownerId });
        const reservation = reservations.get(key)!;
        if (reservation.owner !== context.claim.ownerId) throw new Error("fixture owner collision");
        return { reference: reservation.reference, verifier: reservation.verifier };
      },
      async retire() {},
      async connections(reference, binding): Promise<IdentityConnectionFactory> {
        const reserved = reservations.get(binding.operationKey);
        if (!reserved || reserved.reference !== reference || reserved.owner !== binding.ownerId) throw new Error("fixture reservation mismatch");
        return { async acquire(owner, signal) {
          if (owner !== binding.ownerId || signal?.aborted) throw new Error("fixture owner unavailable");
          await fixture.db.exec("set session authorization postgres");
          await fixture.db.exec(`set session authorization "${binding.roleName}"`);
          let closed = false;
          const close = async () => {
            if (closed) return; closed = true;
            if (fixture.db.isInTransaction()) await fixture.db.exec("ROLLBACK");
            await fixture.db.exec("set session authorization postgres");
          };
          return { binding: { ownerId: owner, roleName: binding.roleName, roleOid: binding.roleOid }, connection: {
            async query(sql, values) {
              if (closed || signal?.aborted) throw new Error("fixture connection stopped");
              const result = await fixture.db.query(sql, values ? [...values] : []);
              if (signal?.aborted) throw new Error("fixture connection stopped");
              return { rows: result.rows };
            }, release: close, discard: close,
          } };
        } };
      },
    };
    function receipt(context: EnrollmentContext): EnrollmentPublication {
      return { ownerId: context.claim.ownerId, generation: context.claim.generation, revision: context.claim.revision,
        capability: context.step.capability, operationKey: context.step.operationKey, receipt: `fixture-publication:${context.step.operationKey}` };
    }
    const publisher: EnrollmentBindingPublisher = {
      async publish(context, binding) {
        await context.store.read(context.claim);
        const previous = publications.get(context.step.operationKey), next = receipt(context);
        if (previous && (previous.generation !== next.generation || previous.revision !== next.revision)) throw new Error("fixture stale publication");
        publications.set(context.step.operationKey, next); bindings.push(binding); return next;
      },
      async verify(context, binding, publication) {
        await context.store.read(context.claim);
        const actual = publications.get(context.step.operationKey);
        if (!actual || actual.receipt !== publication.receipt || binding.ownerId !== actual.ownerId) throw new Error("fixture publication unconfirmed");
        return actual;
      },
      async revoke() { throw new EnrollmentEffectUnavailable("verification_unavailable", true); },
    };
    return { credentials, publisher, reservations, reservedKeys, bindings, publications,
      adapter: createHttpEnrollmentAdapter({ credentials, publisher }) };
  }
  async function resume(owner: string) {
    await fixture.admin(async () => { await fixture.db.query("update fluid_private.account_service_enrollments set available_at=clock_timestamp() where owner_id=$1", [owner]); });
  }
  async function step(owner: string, capability = "home_attachments") {
    return fixture.admin(async () => (await fixture.db.query<{ operation_key: string; phase: string; effects_started: boolean; credential_ref: string | null }>(
      "select s.operation_key,s.phase,s.effects_started,s.credential_ref from fluid_private.account_service_enrollment_steps s join fluid_private.account_service_enrollments e on e.id=s.enrollment_id and e.generation=s.generation where e.owner_id=$1 and s.capability=$2",
      [owner, capability])).rows[0]!);
  }
  it("creates confirmed-user outbox work and leaves all five unavailable when no adapters are configured", async () => {
    const owner = randomUUID(); await fixture.seedUser(owner);
    const result = await reconcileAccountEnrollmentOnce(createSqlEnrollmentStore(fixture.operator), {});
    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("expected work");
    expect(result.enrollment.ownerId).toBe(owner); expect(result.enrollment.status).toBe("pending");
    expect(Object.values(result.enrollment.capabilities)).toEqual([false, false, false, false, false]);
    expect((await step(owner)).effects_started).toBe(false);
  });
  it("drives real HTTP role/binding phases and restricted helper qualification while workers remain explicitly blocked", async () => {
    const owner = randomUUID(); await fixture.seedUser(owner); const p = ports();
    const result = await reconcileAccountEnrollmentOnce(createSqlEnrollmentStore(fixture.operator), {
      home_attachments: p.adapter, identity_transactions: p.adapter,
    });
    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("expected work");
    expect(result.enrollment.ownerId).toBe(owner); expect(result.enrollment.status).toBe("pending");
    expect(result.enrollment.capabilities).toEqual({ home_attachments: true, identity_transactions: true, strategy: false, naming: false, logo: false });
    expect((await step(owner)).phase).toBe("ready"); expect((await step(owner, "identity_transactions")).phase).toBe("ready");
    expect(p.bindings).toHaveLength(2); expect(fixture.db.isInTransaction()).toBe(false);
  });
  it("recovers an unknown SQL acknowledgement with the same operation, reserved credential and actual role OID", async () => {
    const owner = randomUUID(); await fixture.seedUser(owner); const p = ports(), base = createSqlEnrollmentStore(fixture.operator);
    let lost = false;
    const store = { ...base, async provisionHttp(...args: Parameters<typeof base.provisionHttp>) {
      const binding = await base.provisionHttp(...args);
      if (!lost) { lost = true; throw new Error("synthetic lost SQL acknowledgement"); }
      return binding;
    } };
    await reconcileAccountEnrollmentOnce(store, { home_attachments: p.adapter });
    const before = await step(owner); expect(before.phase).toBe("uncertain");
    const firstOid = await fixture.admin(async () => (await fixture.db.query<{ role_oid: number }>(
      "select role_oid from fluid_private.account_enrollment_managed_roles where owner_id=$1 and capability='home_attachments'", [owner])).rows[0]!.role_oid);
    await resume(owner);
    const result = await reconcileAccountEnrollmentOnce(base, { home_attachments: p.adapter });
    expect(result.status === "processed" && result.enrollment.capabilities.home_attachments).toBe(true);
    const after = await step(owner); expect(after.operation_key).toBe(before.operation_key); expect(after.credential_ref).toBe(before.credential_ref);
    expect(p.reservedKeys).toEqual([before.operation_key, before.operation_key]);
    expect(p.bindings[0]!.roleOid).toBe(firstOid);
  });
  it("cannot acknowledge a publication or ready state after the real Auth ban trigger invalidates its lease", async () => {
    const owner = randomUUID(); await fixture.seedUser(owner); const p = ports();
    p.publisher.publish = async (context, binding) => {
      p.bindings.push(binding);
      await fixture.admin(async () => { await fixture.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [owner]); });
      return { ownerId: owner, generation: context.claim.generation, revision: context.claim.revision,
        operationKey: context.step.operationKey, capability: context.step.capability, receipt: "late-after-ban" };
    };
    const result = await reconcileAccountEnrollmentOnce(createSqlEnrollmentStore(fixture.operator), { home_attachments: p.adapter });
    expect(result.status).toBe("stopped"); expect((await step(owner)).phase).toBe("revoking");
    expect(fixture.db.isInTransaction()).toBe(false);
  });
  it("locks actual HTTP SQL authority but retains pending revocation without independent runtime/Storage denial proof", async () => {
    const owner = randomUUID(); await fixture.seedUser(owner); const p = ports(), store = createSqlEnrollmentStore(fixture.operator);
    await reconcileAccountEnrollmentOnce(store, { home_attachments: p.adapter });
    await fixture.admin(async () => { await fixture.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [owner]); });
    const result = await reconcileAccountEnrollmentOnce(store, { home_attachments: p.adapter });
    expect(result.status).toBe("processed");
    const state = await fixture.admin(async () => (await fixture.db.query<{ state: string; login: boolean }>(
      "select e.state,r.rolcanlogin as login from fluid_private.account_service_enrollments e join fluid_private.account_enrollment_managed_roles p on p.owner_id=e.owner_id and p.capability='home_attachments' join pg_roles r on r.oid=p.role_oid where e.owner_id=$1", [owner])).rows[0]!);
    expect(state.login).toBe(false); expect(state.state).toBe("revoking");
    expect((await step(owner)).phase).toBe("revoking");
  });
});
