import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const qualification = vi.hoisted(() => ({ identity: vi.fn(), home: vi.fn() }));
vi.mock("@/server/runtime/identity-qualification", () => ({ qualifyIdentityConnection: qualification.identity }));
vi.mock("@/server/runtime/home-attachment-qualification", () => ({ qualifyHomeAttachmentConnection: qualification.home }));
import { createHttpEnrollmentAdapter } from "@/server/account-enrollment/http-adapter";
import { reconcileAccountEnrollmentOnce, validateEnrollmentRevocation } from "@/server/account-enrollment/reconciler";
import { EnrollmentLeaseUnavailable } from "@/server/account-enrollment/sql-store";
import { enrollmentCapabilities, EnrollmentEffectUnavailable, type EnrollmentBindingPublisher, type EnrollmentCapability,
  type EnrollmentClaim, type EnrollmentContext, type EnrollmentCredentialStore, type EnrollmentHttpBinding,
  type EnrollmentRevocationProof, type EnrollmentStore } from "@/server/account-enrollment/contracts";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const opaque = (context: EnrollmentContext) => `receipt:${context.step.operationKey}`;
const verifier = `SCRAM-SHA-256$4096:${"A".repeat(22)}==$${"B".repeat(43)}=:${"C".repeat(43)}=`;
function initialClaim(): EnrollmentClaim {
  return { id: randomUUID(), ownerId: owner, generation: 1, revision: 1, leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 90_000).toISOString(),
    mode: "enroll", steps: enrollmentCapabilities.map(capability => ({ capability, operationKey: randomUUID(), phase: "pending",
      effectsStarted: false, credentialRef: null, publicationReceipt: null, verificationReceipt: null })) };
}
function fixture() {
  let current = initialClaim(), stale = false, lostProvisionAck = false;
  const events: string[] = [], acknowledged: EnrollmentCapability[] = [];
  const status = () => ({ ownerId: owner, generation: current.generation, status: current.mode === "revoke" ? "unavailable" as const
    : current.steps.every(step => step.phase === "ready") ? "ready" as const : "pending" as const,
  capabilities: Object.fromEntries(current.steps.map(step => [step.capability, step.phase === "ready"])) as Record<EnrollmentCapability, boolean>, updatedAt: new Date().toISOString() });
  const store: EnrollmentStore = {
    operator: { query: vi.fn() },
    claim: vi.fn(async () => structuredClone(current)),
    read: vi.fn(async () => { if (stale) throw new EnrollmentLeaseUnavailable(); return structuredClone(current); }),
    record: vi.fn(async (_claim, capability, phase, reference) => {
      if (stale) throw new EnrollmentLeaseUnavailable();
      events.push(`record:${capability}:${phase}`);
      const step = current.steps.find(candidate => candidate.capability === capability)!;
      step.phase = phase as typeof step.phase;
      if (phase === "provisioning" || phase === "credential_reserved") step.effectsStarted = true;
      if (phase === "credential_reserved") step.credentialRef = reference!;
      if (phase === "published") step.publicationReceipt = reference!;
      if (phase === "ready") step.verificationReceipt = reference!;
      return structuredClone(current);
    }),
    provisionHttp: vi.fn(async (_claim, capability, reservation) => {
      events.push(`sql-provision:${capability}`);
      const step = current.steps.find(candidate => candidate.capability === capability)!; step.phase = "provisioned";
      const binding: EnrollmentHttpBinding = { managementVersion: 2, ownerId: owner, generation: current.generation, revision: current.revision,
        capability, operationKey: step.operationKey, roleName: capability === "home_attachments" ? "embel_home_web_test" : "embel_identity_web_test",
        roleOid: capability === "home_attachments" ? 2001 : 2002, credentialRef: reservation.reference,
        managerRoleName: "embel_account_role_manager", managerRoleOid: 1000 };
      if (lostProvisionAck) { lostProvisionAck = false; throw new Error("private unacknowledged connection failure"); }
      return binding;
    }),
    lockHttp: vi.fn(async () => { events.push("sql-lock"); }),
    acknowledgeRevocation: vi.fn(async (_claim, capability) => { if (stale) throw new EnrollmentLeaseUnavailable(); acknowledged.push(capability); }),
    finish: vi.fn(async (_claim, revoked = []) => {
      if (stale) throw new EnrollmentLeaseUnavailable();
      for (const capability of revoked) current.steps.find(step => step.capability === capability)!.phase = "revoked";
      return status();
    }),
  };
  const credentials: EnrollmentCredentialStore = {
    reserve: vi.fn(async context => { events.push(`reserve:${context.step.operationKey}`); return { reference: `secret:${context.step.operationKey}`, verifier }; }),
    retire: vi.fn(async () => { events.push("retire"); }),
    connections: vi.fn(async () => ({ acquire: vi.fn() })),
  };
  const publication = (context: EnrollmentContext) => ({ ownerId: owner, generation: context.claim.generation, revision: context.claim.revision,
    operationKey: context.step.operationKey, capability: context.step.capability, receipt: opaque(context) });
  const proof = (context: EnrollmentContext): EnrollmentRevocationProof => ({ ...publication(context), observedAt: new Date().toISOString(),
    authorityDisabled: true, runtimeStopped: true, storageDenied: true });
  const publisher: EnrollmentBindingPublisher = {
    publish: vi.fn(async context => { events.push("publish"); return publication(context); }),
    verify: vi.fn(async context => { events.push("verify-publication"); return publication(context); }),
    revoke: vi.fn(async context => { events.push("withdraw-and-probe"); return proof(context); }),
  };
  const adapter = createHttpEnrollmentAdapter({ credentials, publisher });
  return { store, credentials, publisher, adapter, events, acknowledged, proof, current: () => current,
    replace: (value: EnrollmentClaim) => { current = value; }, stale: () => { stale = true; }, loseProvisionAck: () => { lostProvisionAck = true; } };
}

describe("lease-bound account enrollment reconciler", () => {
  it("accepts fresh SQL-proven never-provisioned worker authority without inventing a stopped runtime", () => {
    const f = fixture(), claim = f.current(), step = claim.steps.find(step => step.capability === "logo")!;
    claim.mode = "revoke"; const context = { claim, step, store: f.store };
    const { runtimeStopped, ...common } = f.proof(context); void runtimeStopped;
    const absence = { ...common, capability: "logo" as const, scope: "never_provisioned" as const, authorityAbsent: true as const };
    expect(validateEnrollmentRevocation(context, absence)).toEqual(absence);
    expect(validateEnrollmentRevocation(context, absence)).not.toHaveProperty("runtimeStopped");
    for (const invalid of [{ ...absence, runtimeStopped: true }, { ...absence, authorityAbsent: false },
      { ...absence, capability: "home_attachments" }, { ...absence, revision: claim.revision + 1 }]) {
      expect(() => validateEnrollmentRevocation(context, invalid)).toThrow(EnrollmentEffectUnavailable);
    }
  });
  it("maintains completed worker operations through the same lease without credentials, new operation keys or HTTP reprovisioning", async () => {
    const f = fixture(), original = f.current();
    for (const step of original.steps) step.phase = "ready";
    const before = structuredClone(original), reconcile = vi.fn(), maintain = vi.fn(async (context: EnrollmentContext) => {
      expect(context.claim.id).toBe(before.id); expect(context.claim.generation).toBe(before.generation);
      expect(context.step.operationKey).toBe(before.steps.find(step => step.capability === context.step.capability)!.operationKey);
    });
    const worker = { maintain, reconcile, revoke: vi.fn() };
    await reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter, identity_transactions: f.adapter, strategy: worker, naming: worker, logo: worker });
    expect(maintain.mock.calls.map(([context]) => context.step.capability)).toEqual(["strategy", "naming", "logo"]);
    expect(reconcile).not.toHaveBeenCalled(); expect(f.credentials.reserve).not.toHaveBeenCalled(); expect(f.store.record).not.toHaveBeenCalled();
    expect(f.current()).toEqual(before); expect(f.store.finish).toHaveBeenCalledTimes(1);
  });
  it("keeps observation state intact on maintenance failure while later capabilities still receive inspection", async () => {
    const f = fixture(); for (const step of f.current().steps) step.phase = "ready";
    const failed = { maintain: vi.fn(async () => { throw new EnrollmentEffectUnavailable("verification_unavailable"); }), reconcile: vi.fn(), revoke: vi.fn() };
    const healthy = { maintain: vi.fn(async () => {}), reconcile: vi.fn(), revoke: vi.fn() };
    await reconcileAccountEnrollmentOnce(f.store, { naming: failed, logo: healthy });
    expect(healthy.maintain).toHaveBeenCalledTimes(1); expect(f.store.record).not.toHaveBeenCalled(); expect(f.store.lockHttp).not.toHaveBeenCalled();
    expect(f.current().steps.every(step => step.phase === "ready")).toBe(true); // Durable completion, not a live health assertion.
  });
  it("stops same-operation maintenance after a concurrent account revision invalidates its lease", async () => {
    const f = fixture(); for (const step of f.current().steps) step.phase = "ready";
    const first = { maintain: vi.fn(async () => { f.stale(); }), reconcile: vi.fn(), revoke: vi.fn() };
    const later = { maintain: vi.fn(async () => {}), reconcile: vi.fn(), revoke: vi.fn() };
    expect(await reconcileAccountEnrollmentOnce(f.store, { naming: first, logo: later })).toEqual({ status: "stopped" });
    expect(later.maintain).not.toHaveBeenCalled(); expect(f.store.finish).not.toHaveBeenCalled(); expect(f.credentials.reserve).not.toHaveBeenCalled();
  });
  it("keeps all five capabilities pending when no approved adapters exist", async () => {
    const f = fixture();
    const result = await reconcileAccountEnrollmentOnce(f.store, {});
    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("missing result");
    expect(result.enrollment.status).toBe("pending"); expect(Object.values(result.enrollment.capabilities)).toEqual([false, false, false, false, false]);
    expect(f.store.record).toHaveBeenCalledTimes(5); expect(f.credentials.reserve).not.toHaveBeenCalled();
  });
  it("cannot turn an adapter's empty success into SQL readiness", async () => {
    const f = fixture(), adapter = { reconcile: vi.fn(async () => {}), revoke: vi.fn() };
    const result = await reconcileAccountEnrollmentOnce(f.store, { home_attachments: adapter, identity_transactions: adapter });
    expect(result.status === "processed" && result.enrollment.status).toBe("pending");
    expect(f.current().steps.filter(step => step.phase === "ready")).toHaveLength(0);
  });
  it("checkpoints HTTP effects before reservation, publishes and independently qualifies without declaring workers ready", async () => {
    qualification.home.mockResolvedValue(undefined); qualification.identity.mockResolvedValue(undefined);
    const f = fixture();
    const result = await reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter, identity_transactions: f.adapter });
    expect(result.status === "processed" && result.enrollment.status).toBe("pending");
    expect(f.current().steps.filter(step => step.phase === "ready").map(step => step.capability)).toEqual(["home_attachments", "identity_transactions"]);
    const operation = f.current().steps[0]!.operationKey;
    expect(f.events.indexOf("record:home_attachments:provisioning")).toBeLessThan(f.events.indexOf(`reserve:${operation}`));
    expect(f.events.indexOf("record:home_attachments:credential_reserved")).toBeLessThan(f.events.indexOf("sql-provision:home_attachments"));
    expect(qualification.home).toHaveBeenCalledWith(expect.anything(), owner, "embel_home_web_test", 2001, expect.any(AbortSignal),
      expect.objectContaining({ managementVersion: 2, revision: 1, generation: 1, operationKey: operation }));
  });
  it("does not begin an external effect with a missing store or publisher", async () => {
    for (const missing of ["store", "publisher"]) {
      const f = fixture(), adapter = createHttpEnrollmentAdapter({ credentials: missing === "store" ? null : f.credentials,
        publisher: missing === "publisher" ? null : f.publisher });
      await reconcileAccountEnrollmentOnce(f.store, { home_attachments: adapter });
      expect(f.current().steps[0]!.effectsStarted).toBe(false); expect(f.credentials.reserve).not.toHaveBeenCalled(); expect(f.store.provisionHttp).not.toHaveBeenCalled();
    }
  });
  it("retains operation identity and reservation when SQL provisioning succeeds but its acknowledgement is lost", async () => {
    const f = fixture(), key = f.current().steps[0]!.operationKey; f.loseProvisionAck();
    await reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter });
    expect(f.current().steps[0]!.phase).toBe("uncertain");
    await reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter });
    expect(f.current().steps[0]!.phase).toBe("ready");
    expect(vi.mocked(f.credentials.reserve).mock.calls.map(([context]) => context.step.operationKey)).toEqual([key, key]);
    expect(f.current().steps[0]!.credentialRef).toBe(`secret:${key}`);
  });
  it("rejects stale generation/revision publication without a ready checkpoint", async () => {
    const f = fixture();
    vi.mocked(f.publisher.publish).mockImplementation(async context => ({ ownerId: owner, generation: context.claim.generation,
      revision: context.claim.revision + 1, operationKey: context.step.operationKey, capability: context.step.capability, receipt: "stale" }));
    await reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter });
    expect(f.current().steps[0]!.phase).toBe("uncertain"); expect(f.publisher.verify).not.toHaveBeenCalled();
  });
  it("stops a stale lease after publication instead of activating late results", async () => {
    const f = fixture();
    vi.mocked(f.publisher.publish).mockImplementation(async context => { f.stale(); return { ownerId: owner,
      generation: context.claim.generation, revision: context.claim.revision, operationKey: context.step.operationKey,
      capability: context.step.capability, receipt: "published-before-ban" }; });
    expect((await reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter })).status).toBe("stopped");
    expect(f.store.finish).not.toHaveBeenCalled(); expect(f.current().steps[0]!.phase).not.toBe("ready");
  });
  it("cannot acknowledge revocation from an Auth denial or missing Storage/runtime proof", async () => {
    const f = fixture();
    for (const step of f.current().steps) { step.phase = "revoking"; step.effectsStarted = true; }
    f.current().mode = "revoke";
    vi.mocked(f.publisher.revoke).mockResolvedValue({ ownerId: owner, generation: 1, revision: 1,
      operationKey: f.current().steps[0]!.operationKey, capability: "home_attachments", receipt: "auth403", observedAt: new Date().toISOString(),
      authorityDisabled: true, runtimeStopped: true, storageDenied: false } as never);
    await reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter });
    expect(f.store.lockHttp).toHaveBeenCalled(); expect(f.acknowledged).toEqual([]);
    expect(vi.mocked(f.store.finish).mock.calls[0]![1]).toEqual([]);
  });
  it("acknowledges only fresh bound revocation proof and retains missing worker drains", async () => {
    const f = fixture(); f.current().mode = "revoke";
    for (const step of f.current().steps) { step.phase = "revoking"; step.effectsStarted = true; }
    await reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter, identity_transactions: f.adapter });
    expect(f.acknowledged).toEqual(["home_attachments", "identity_transactions"]);
    expect(f.events.indexOf("sql-lock")).toBeLessThan(f.events.indexOf("withdraw-and-probe"));
    expect(f.current().steps.filter(step => step.phase === "revoked")).toHaveLength(2);
  });
  it("rejects stale revocation observations even when every claimed flag is true", async () => {
    const f = fixture(); f.current().mode = "revoke";
    for (const step of f.current().steps) { step.phase = "revoking"; step.effectsStarted = true; }
    vi.mocked(f.publisher.revoke).mockImplementation(async context => ({ ...f.proof(context), observedAt: new Date(Date.now() - 60_000).toISOString() }));
    await reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter }); expect(f.acknowledged).toEqual([]);
  });
  it("cancels an ignored external wait without finishing or accepting its late success", async () => {
    const f = fixture(), controller = new AbortController();
    let resolve!: () => void;
    vi.mocked(f.credentials.reserve).mockImplementation(async context => { await new Promise<void>(done => { resolve = done; });
      return { reference: `secret:${context.step.operationKey}`, verifier }; });
    const result = reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter }, { signal: controller.signal });
    await vi.waitFor(() => expect(f.credentials.reserve).toHaveBeenCalled()); controller.abort();
    expect((await result).status).toBe("stopped"); resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.store.provisionHttp).not.toHaveBeenCalled(); expect(f.store.finish).not.toHaveBeenCalled();
  });
  it("keeps unknown external errors sanitized and uncertain", async () => {
    const f = fixture(); vi.mocked(f.credentials.reserve).mockRejectedValue(new Error("secret credential details"));
    await reconcileAccountEnrollmentOnce(f.store, { home_attachments: f.adapter });
    expect(f.current().steps[0]!.phase).toBe("uncertain");
    expect(f.store.record).toHaveBeenCalledWith(expect.anything(), "home_attachments", "uncertain", "store_unavailable");
    expect(new EnrollmentEffectUnavailable("store_unavailable").message).not.toContain("secret");
  });
});
