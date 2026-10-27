import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSqlEnrollmentStore, EnrollmentLeaseUnavailable } from "@/server/account-enrollment/sql-store";
import { readAccountServiceEnrollment, ensureAccountServiceEnrollment } from "@/server/data/account-enrollment";
import { enrollmentCapabilities, EnrollmentEffectUnavailable, type EnrollmentClaim } from "@/server/account-enrollment/contracts";
import type { AuthenticatedContext } from "@/server/auth/context";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const claim = (): EnrollmentClaim => ({ id: randomUUID(), ownerId: owner, generation: 1, revision: 1, leaseToken: randomUUID(),
  leaseUntil: new Date(Date.now() + 60_000).toISOString(), mode: "enroll", steps: enrollmentCapabilities.map(capability => ({
    capability, operationKey: randomUUID(), phase: "pending", effectsStarted: false, credentialRef: null, publicationReceipt: null, verificationReceipt: null })) });
const status = () => ({ ownerId: owner, generation: 1, status: "pending", capabilities: { home_attachments: false,
  identity_transactions: false, strategy: false, naming: false, logo: false }, updatedAt: "2026-10-27T00:00:00Z" });

describe("fixed enrollment operator SQL adapter", () => {
  it("claims bounded work with no browser-selected owner argument", async () => {
    const query = vi.fn(async () => ({ rows: [{ value: null }] })), store = createSqlEnrollmentStore({ query });
    expect(await store.claim()).toBeNull();
    expect(query).toHaveBeenCalledExactlyOnceWith("SELECT public.claim_account_service_enrollment($1::integer) AS value", [120]);
  });
  it.each(["owner", "generation", "revision", "token", "operation", "credential", "publication"])("rejects changed %s when re-reading a claim", async mode => {
    const before = claim(), after = structuredClone(before);
    if (mode === "owner") after.ownerId = other;
    if (mode === "generation") after.generation += 1;
    if (mode === "revision") after.revision += 1;
    if (mode === "token") after.leaseToken = randomUUID();
    if (mode === "operation") after.steps[0]!.operationKey = randomUUID();
    if (mode === "credential") { before.steps[0]!.credentialRef = "secret:original"; after.steps[0]!.credentialRef = "secret:changed"; }
    if (mode === "publication") { before.steps[0]!.publicationReceipt = "publication:original"; after.steps[0]!.publicationReceipt = "publication:changed"; }
    const store = createSqlEnrollmentStore({ query: vi.fn(async () => ({ rows: [{ value: after }] })) });
    await expect(store.read(before)).rejects.toBeInstanceOf(EnrollmentLeaseUnavailable);
  });
  it("passes only the leased ID/token and reserved SCRAM/reference to HTTP provisioning", async () => {
    const work = claim(), operationKey = work.steps[0]!.operationKey;
    const value = { managementVersion: 2, ownerId: owner, generation: 1, revision: 1, capability: "home_attachments", operationKey,
      roleName: "embel_home_web_test", roleOid: 123, managerRoleName: "embel_account_role_manager", managerRoleOid: 99, credentialRef: "secret:stable" };
    const query = vi.fn(async () => ({ rows: [{ value }] })), store = createSqlEnrollmentStore({ query });
    expect(await store.provisionHttp(work, "home_attachments", { reference: "secret:stable", verifier: "synthetic-SCRAM-verifier" })).toEqual(value);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("provision_account_enrollment_http"),
      [work.id, work.leaseToken, "home_attachments", "secret:stable", "synthetic-SCRAM-verifier"]);
  });
  it("does not accept a provisioning receipt for another owner/capability operation", async () => {
    const work = claim(), value = { managementVersion: 2, ownerId: other, generation: 1, revision: 1, capability: "home_attachments",
      operationKey: work.steps[0]!.operationKey, roleName: "embel_home_web_test", roleOid: 123,
      managerRoleName: "embel_account_role_manager", managerRoleOid: 99, credentialRef: "secret:stable" };
    const store = createSqlEnrollmentStore({ query: vi.fn(async () => ({ rows: [{ value }] })) });
    await expect(store.provisionHttp(work, "home_attachments", { reference: "secret:stable", verifier: "synthetic" }))
      .rejects.toBeInstanceOf(EnrollmentLeaseUnavailable);
  });
  it("requires an exact owner/capability revocation acknowledgement", async () => {
    const work = claim(), query = vi.fn(async () => ({ rows: [{ value: { ownerId: owner, generation: 1, capability: "naming", acknowledged: true } }] }));
    const store = createSqlEnrollmentStore({ query });
    await expect(store.acknowledgeRevocation(work, "home_attachments", "fresh:proof")).rejects.toBeInstanceOf(EnrollmentLeaseUnavailable);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("acknowledge_account_enrollment_revocation"), [work.id, work.leaseToken, "home_attachments", "fresh:proof"]);
  });
  it("never parses partial all-capability success as a ready account", async () => {
    const store = createSqlEnrollmentStore({ query: vi.fn(async () => ({ rows: [{ value: { ...status(), status: "ready" } }] })) });
    await expect(store.finish(claim())).rejects.toBeInstanceOf(EnrollmentEffectUnavailable);
  });
  it("classifies SQL lease rejection separately and never exposes credential-bearing errors", async () => {
    const query = vi.fn(async () => { throw Object.assign(new Error("private credential verifier"), { code: "42501" }); });
    const store = createSqlEnrollmentStore({ query });
    await expect(store.read(claim())).rejects.toBeInstanceOf(EnrollmentLeaseUnavailable);
    query.mockRejectedValueOnce(Object.assign(new Error("private credential verifier"), { code: "08006" }));
    await expect(store.read(claim())).rejects.toMatchObject({ message: "Account enrollment effect is unavailable", uncertain: true });
  });
});

describe("confirmed account enrollment data transport", () => {
  function auth() {
    const rpc = vi.fn(async () => ({ data: status(), error: null }));
    return { account: { userId: owner, client: { rpc } } as unknown as AuthenticatedContext, rpc };
  }
  it("derives both RPCs from the verified account and supplies no owner or role parameters", async () => {
    const f = auth();
    expect(await ensureAccountServiceEnrollment(f.account)).toEqual(status());
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith("ensure_account_service_enrollment");
    f.rpc.mockClear(); expect(await readAccountServiceEnrollment(f.account)).toEqual(status());
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith("get_account_service_enrollment");
  });
  it("treats missing SQL and missing grants as integration unavailable, not a lost Auth session", async () => {
    for (const error of [{ code: "PGRST202", message: "function missing" }, { code: "42883", message: "function missing" },
      { code: "42501", message: "permission denied for function" }]) {
      const f = auth(); f.rpc.mockResolvedValue({ data: null, error } as never);
      await expect(ensureAccountServiceEnrollment(f.account)).rejects.toMatchObject({ code: "integration_unavailable", status: 503 });
    }
    const f = auth(); f.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "account_enrollment_unauthenticated" } } as never);
    await expect(ensureAccountServiceEnrollment(f.account)).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  });
  it("rejects foreign or malformed status and preserves an older account's absent read without invented readiness", async () => {
    const f = auth(); f.rpc.mockResolvedValue({ data: { ...status(), ownerId: other }, error: null } as never);
    await expect(readAccountServiceEnrollment(f.account)).rejects.toMatchObject({ code: "not_found" });
    f.rpc.mockResolvedValue({ data: null, error: null } as never);
    expect(await readAccountServiceEnrollment(f.account)).toBeNull();
    await expect(ensureAccountServiceEnrollment(f.account)).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("ignores late data after cancellation and keeps raw provider failures private", async () => {
    const f = auth(), controller = new AbortController();
    f.rpc.mockImplementation(async () => { controller.abort(); return { data: status(), error: null }; });
    await expect(readAccountServiceEnrollment(f.account, controller.signal)).rejects.toMatchObject({ code: "integration_unavailable" });
    f.rpc.mockRejectedValue(new Error("private credential information"));
    await expect(readAccountServiceEnrollment(f.account)).rejects.toMatchObject({ message: "This integration is not configured or is unavailable." });
  });
});
