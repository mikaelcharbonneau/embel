import { createHash } from "node:crypto";
import { rootCertificates } from "node:tls";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainJobInputSchema } from "../../src/domain/naming-brain";
import { createNamingBrainPolicy } from "../../src/server/ai/naming-brain/policy";
import { HOSTED_APPLICATION_ORIGIN } from "../../src/server/runtime/hosted-application";
import type { OwnerWorkerProcessDescriptor } from "../../worker/account-enrollment/adapter";
import { approvedWorkerProfileSchema, ownerWorkerRole, workerProfileFingerprint } from "../../worker/account-enrollment/configuration";
import { OwnerNamingJobStore, OWNER_NAMING_FUNCTIONS, qualifyOwnerNamingRuntime, runOwnerNamingRuntime, verifyOwnerNamingSession, type OwnerNamingRuntimeSecrets } from "../../worker/account-enrollment/naming-runtime";
import { parseClaimedJob } from "../../worker/postgres-store";
import * as qualification from "../../worker/account-enrollment/process-qualification";
import { createInertNamingHarness } from "./naming-brain-handler-fixture";
import { id } from "../domain/naming-brain-fixtures";

/** Synthetic public artifact identifiers; never a production qualification. */
function fixture() {
  const runtime = { node: process.versions.node, icu: process.versions.icu!, unicode: process.versions.unicode!, platform: "linux" as const, arch: "x64" as const };
  const artifactSha256 = createHash("sha256").update("explicit synthetic worker fixture").digest("hex");
  const profile = approvedWorkerProfileSchema.parse({ capability: "naming", profileId: "synthetic-naming-profile", providerBindingRef: "synthetic-provider-binding", modelVerificationReceipt: "synthetic-model-receipt",
    applicationOrigin: HOSTED_APPLICATION_ORIGIN, supabaseOrigin: "https://fricsfwqibyhemknqgyf.supabase.co", projectId: "prj_syntheticnamingprofile", deploymentId: "dpl_syntheticnamingprofile",
    sourceRevision: "b".repeat(40), artifactSha256, managedProofSha256: "c".repeat(64), runtime, dispatchApproved: true,
    model: "gpt-6-luna", admissionContract: "hosted_owner_v1", providerBudgetVersion: 2, spendControl: "uncapped", policyIdentity: "d".repeat(64) });
  const descriptor: OwnerWorkerProcessDescriptor = { version: 1, binding: { ownerId: id(1), generation: 1, revision: 1, operationKey: id(50), capability: "naming", roleName: ownerWorkerRole("naming", id(1)), roleOid: 123456,
    credentialRef: "synthetic-database-credential", workerId: "synthetic-owner-naming", deploymentId: profile.deploymentId, profileFingerprint: workerProfileFingerprint(profile), storageAuthUserId: null }, profile };
  const secrets: OwnerNamingRuntimeSecrets = { database: { databaseUrl: `postgresql://${descriptor.binding.roleName}:synthetic-not-a-real-password@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full`, caPem: rootCertificates[0]! },
    provider: { apiKey: "synthetic-never-sent-key", model: "gpt-6-luna", modelVerificationReceipt: profile.modelVerificationReceipt }, policy: createNamingBrainPolicy("gpt-6-luna"),
    attestation: { sourceRevision: profile.sourceRevision, sourceClean: true, artifactSha256, deploymentId: profile.deploymentId, runtime } };
  return { descriptor, secrets };
}

describe("per-owner Naming startup rejection without I/O", () => {
  it("constructs the Naming configuration after explicitly stubbed artifact/CA qualification, without claiming readiness", () => {
    const { descriptor, secrets } = fixture();
    // Isolated pure-validator unit only. The real qualification gate is tested
    // separately below and is never replaced with fabricated platform metadata.
    const artifact = vi.spyOn(qualification, "assertOwnerWorkerArtifact").mockImplementation(() => {});
    const database = vi.spyOn(qualification, "ownerWorkerPoolOptions").mockReturnValue({ max: 2 });
    try { expect(qualifyOwnerNamingRuntime(descriptor, secrets).descriptor).toEqual(descriptor); }
    finally { artifact.mockRestore(); database.mockRestore(); }
  });

  it.each(["provider-key", "model", "model-receipt", "policy", "database", "ca", "owner-role", "role-oid", "revision", "fingerprint", "artifact", "dirty-artifact", "runtime", "managed-pin"] as const)("rejects unavailable or mismatched %s without creating a pool or emitting readiness", async defect => {
    const { descriptor, secrets } = structuredClone(fixture());
    if (defect === "provider-key") (secrets.provider as { apiKey: string }).apiKey = "";
    if (defect === "model") (secrets.provider as { model: string }).model = "unapproved-model";
    if (defect === "model-receipt") (secrets.provider as { modelVerificationReceipt: string }).modelVerificationReceipt = "another-receipt";
    if (defect === "policy") Reflect.deleteProperty(secrets, "policy");
    if (defect === "database") (secrets.database as { databaseUrl: string }).databaseUrl = "";
    if (defect === "ca") (secrets.database as { caPem: string }).caPem = "";
    if (defect === "owner-role") descriptor.binding.roleName = "fluid_naming_brain_worker";
    if (defect === "role-oid") descriptor.binding.roleOid = 0;
    if (defect === "revision") descriptor.binding.revision = 0;
    if (defect === "fingerprint") descriptor.binding.profileFingerprint = "0".repeat(64);
    if (defect === "artifact") (secrets.attestation as { artifactSha256: string }).artifactSha256 = "0".repeat(64);
    if (defect === "dirty-artifact") (secrets.attestation as { sourceClean: boolean }).sourceClean = false;
    if (defect === "runtime") (secrets.attestation.runtime as { node: string }).node = "0.0.0";
    if (defect === "managed-pin") Reflect.deleteProperty(descriptor.profile, "managedProofSha256");
    const artifact = vi.spyOn(qualification, "assertOwnerWorkerArtifact").mockImplementation(() => {});
    const database = vi.spyOn(qualification, "ownerWorkerPoolOptions").mockReturnValue({ max: 2 });
    const pool = vi.spyOn(qualification, "createOwnerWorkerPool"), ready = vi.fn();
    try {
      await expect(runOwnerNamingRuntime({ descriptor, secrets, signal: new AbortController().signal, onReady: ready })).rejects.toThrow("owner_naming_runtime_unavailable");
      expect(pool).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled();
    } finally { pool.mockRestore(); artifact.mockRestore(); database.mockRestore(); }
  });

  it("does not turn a matching fixture descriptor into real production artifact/platform proof", () => {
    const { descriptor, secrets } = fixture();
    expect(() => qualifyOwnerNamingRuntime(descriptor, secrets)).toThrow("owner_naming_runtime_unavailable");
  });
});

describe("Naming-specific session boundary (explicit catalog/proof unit fixtures)", () => {
  it.each(["qualified", "foreign-owner", "stale-revision", "wrong-operation", "unreviewed-helper", "public-execute", "superuser", "membership", "missing-rpc", "wrong-policy"] as const)("checks %s without requiring unrelated Identity setup", async mode => {
    const { descriptor, secrets } = fixture(), binding = descriptor.binding;
    const role = { session_user: binding.roleName, current_user: binding.roleName, database: "postgres", role_oid: binding.roleOid, rolcanlogin: true, rolinherit: false, rolsuper: mode === "superuser", rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolconnlimit: 4, has_memberships: mode === "membership", owns_objects: false };
    const helper = { prosecdef: true, provolatile: "s", proretset: false, pronargs: 0, pronargdefaults: 0, lanname: "plpgsql", proconfig: ['search_path=""'], result_type: "jsonb", owner_name: "postgres", proleakproof: false,
      public_execution_denied: mode !== "public-execute", body_sha256: mode === "unreviewed-helper" ? "0".repeat(64) : descriptor.profile.managedProofSha256, callable: true };
    const proof = { version: 2, ownerId: mode === "foreign-owner" ? id(999) : binding.ownerId, generation: binding.generation, revision: mode === "stale-revision" ? binding.revision + 1 : binding.revision,
      operationKey: mode === "wrong-operation" ? id(999) : binding.operationKey, capability: "naming", roleName: binding.roleName, roleOid: binding.roleOid,
      managerRoleName: "embel_account_role_manager", managerRoleOid: 11111, identityHelperOwnerQualified: false };
    const database = { query: vi.fn(async (sql: string) => {
      const value = sql.includes("from pg_catalog.pg_roles r where") ? role : sql.includes("p.prosecdef") ? helper
        : sql.includes("managed_principal() proof") ? { proof } : sql.includes("from unnest") ? { found: OWNER_NAMING_FUNCTIONS.length, available: mode !== "missing-rpc" }
          : { policy_identity: mode === "wrong-policy" ? "0".repeat(64) : "d".repeat(64) };
      return { rows: [value] };
    }) };
    // These explicit simulated rows test the Naming checks, not a real database,
    // managed principal, artifact, TLS connection or production-ready process.
    const check = verifyOwnerNamingSession(database, { descriptor, secrets, poolOptions: {} });
    if (mode === "qualified") await expect(check).resolves.toBeUndefined();
    else await expect(check).rejects.toThrow("owner_naming_runtime_unavailable");
    expect(database.query.mock.calls.every(([sql]) => !/\b(?:insert|update|delete|grant|alter)\b/iu.test(sql))).toBe(true);
  });
});

describe("owner-scoped hosted Naming claims", () => {
  it.each(["hosted-v2", "foreign-owner", "local", "capped", "unproven"] as const)("accepts only the original owned hosted-v2 claim (%s)", async mode => {
    const f = createInertNamingHarness({ localPrototype: true });
    const input = namingBrainJobInputSchema.parse({ ...f.input, localTimingVersion: 2, localPipelineVersion: 2,
      ...(mode === "local" ? {} : { executionAuthority: "hosted_owner_v1", providerBudgetVersion: mode === "capped" ? 1 : 2 }) });
    const row = { ...f.jobRow, input };
    const query = vi.fn(async (sql: string) => { expect(sql).toContain("naming_brain_worker_maintenance_v2"); return { rows: [{ result: { mode: "execute", executionAuthority: mode === "local" ? "local_owner_v1" : mode === "unproven" ? null : "hosted_owner_v1", job: row } }] }; });
    const store = new OwnerNamingJobStore({ query }, mode === "foreign-owner" ? id(999) : input.snapshot.ownerId, "synthetic-deployment", () => ({ workerId: "synthetic-worker", generation: 1 }), async () => {});
    if (mode === "hosted-v2") {
      const job = await store.claim("synthetic-worker", 120); expect(job).not.toBeNull(); expect(store.executionAuthority(job!)).toBe("hosted_owner_v1");
    } else await expect(store.claim("synthetic-worker", 120)).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toContain("naming_brain_worker_maintenance_v2");
  });

  it("refuses paid continuation after an enrollment fence without changing the durable lease", async () => {
    const f = createInertNamingHarness({ localPrototype: true }), query = vi.fn();
    const store = new OwnerNamingJobStore({ query }, f.input.snapshot.ownerId, "synthetic-deployment", () => ({ workerId: "synthetic-worker", generation: 1 }), async () => { throw Error("synthetic-secret-shaped-failure"); });
    await expect(store.assertContinuation(parseClaimedJob(f.jobRow))).rejects.toMatchObject({ name: "NamingContinuationUnavailableError", message: "naming_continuation_unavailable" });
    expect(query).not.toHaveBeenCalled();
  });
});
