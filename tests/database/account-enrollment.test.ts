import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountEnrollmentFixture } from "./account-enrollment-fixture";
import { asRole, OWNER_A, OWNER_B } from "./local-supabase";

describe("confirmed account durable enrollment outbox and real SQL leases (disposable fixture)", () => {
  let fixture: Awaited<ReturnType<typeof createAccountEnrollmentFixture>>;
  beforeAll(async () => { fixture = await createAccountEnrollmentFixture(); }, 60_000);
  afterAll(async () => { await fixture?.close(); });
  it("queues exactly five capability intents once for a confirmed user and denies anonymous raw access", async () => {
    await fixture.seedUser(OWNER_A);
    const initial = await asRole(fixture.db, "authenticated", OWNER_A, async () =>
      (await fixture.db.query<{ value: { ownerId: string; status: string; capabilities: Record<string, boolean> } }>("select public.ensure_account_service_enrollment() value")).rows[0]!.value);
    expect(initial.ownerId).toBe(OWNER_A); expect(initial.status).toBe("pending");
    expect(Object.keys(initial.capabilities)).toHaveLength(5); expect(Object.values(initial.capabilities)).toEqual([false, false, false, false, false]);
    const again = await asRole(fixture.db, "authenticated", OWNER_A, async () =>
      (await fixture.db.query<{ value: unknown }>("select public.ensure_account_service_enrollment() value")).rows[0]!.value);
    expect(again).toEqual(initial);
    await expect(asRole(fixture.db, "anon", null, () => fixture.db.query("select * from fluid_private.account_service_enrollments"))).rejects.toMatchObject({ code: "42501" });
  });
  it("waits for confirmation and excludes anonymous, banned and deleted users", async () => {
    await fixture.seedUser(OWNER_B, { confirmed: false });
    await expect(asRole(fixture.db, "authenticated", OWNER_B, () => fixture.db.query("select public.ensure_account_service_enrollment()"))).rejects.toMatchObject({ code: "42501" });
    expect((await fixture.db.query("select owner_id from fluid_private.account_service_enrollments where owner_id=$1", [OWNER_B])).rows).toEqual([]);
    await fixture.db.query("update auth.users set email_confirmed_at=clock_timestamp() where id=$1", [OWNER_B]);
    expect((await fixture.db.query("select owner_id from fluid_private.account_service_enrollments where owner_id=$1", [OWNER_B])).rows).toHaveLength(1);
  });
  it("issues a real operator-bound lease and rejects user/forged/expired lease calls", async () => {
    await expect(asRole(fixture.db, "authenticated", OWNER_A, () => fixture.db.query("select public.claim_account_service_enrollment()"))).rejects.toMatchObject({ code: "42501" });
    const claimed = (await fixture.operator.query("select public.claim_account_service_enrollment() value")).rows[0] as { value: { id: string; leaseToken: string; steps: { operationKey: string }[] } };
    expect(claimed.value.steps).toHaveLength(5);
    await expect(fixture.operator.query("select public.read_account_service_enrollment_claim($1,$2)", [claimed.value.id, "ffffffff-ffff-4fff-8fff-ffffffffffff"]))
      .rejects.toMatchObject({ code: "42501" });
    await fixture.db.query("update fluid_private.account_service_enrollments set lease_until=clock_timestamp()-interval '1 second' where id=$1", [claimed.value.id]);
    await expect(fixture.operator.query("select public.read_account_service_enrollment_claim($1,$2)", [claimed.value.id, claimed.value.leaseToken]))
      .rejects.toMatchObject({ code: "42501" });
  });
});
