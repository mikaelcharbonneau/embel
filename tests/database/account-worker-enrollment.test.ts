import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { installGenerativeStorageFixture } from "./logo-generative-storage-fixture";
import { brainPolicy } from "./naming-brain-fixture";
import { brainPreferences, brainRpc, initialIntent } from "./naming-brain-fixture";
import { NamingBrainJobStore, normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { namingBrainJobInputSchema, namingProviderReceiptSchema } from "../../src/domain/naming-brain";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createProgressiveNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema, logoDispatchReceiptSchema } from "../../src/domain/logo-jobs";
import { randomUUID } from "node:crypto";
import { workerProfileFingerprint, type ApprovedWorkerProfile } from "../../worker/account-enrollment/configuration";

const operator = "fixture_account_worker_operator", reporter = "fixture_account_worker_reporter";
// Public inert SCRAM syntax only. No real credential, provider, process or host.
const verifier = `SCRAM-SHA-256$4096:${"A".repeat(22)}==$${"A".repeat(43)}=:${"A".repeat(43)}=`;
const policy = { ...brainPolicy, model: "gpt-6-luna" };
type Claim = { id: string; ownerId: string; generation: number; revision: number; leaseToken: string; steps: { capability: string; operationKey: string }[] };
type Binding = { ownerId: string; generation: number; revision: number; operationKey: string; capability: string; roleName: string; roleOid: number;
  credentialRef: string; workerId: string; deploymentId: string; profileFingerprint: string; storageAuthUserId: string | null };

describe("unapplied account worker enrollment over actual restricted SQL", () => {
  let db: TestDatabase;
  async function session<T>(role: string, work: () => Promise<T>) {
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) throw Error("Invalid inert fixture role");
    await db.exec("savepoint worker_test_call");
    await db.exec(`set session authorization ${role}`);
    try { return await work(); }
    catch (error) { await db.exec("rollback to savepoint worker_test_call"); throw error; }
    finally { await db.exec("set session authorization postgres; release savepoint worker_test_call"); }
  }
  async function rpc<T>(name: string, values: unknown[] = [], role = operator): Promise<T> {
    if (!/^[a-z_]+$/u.test(name)) throw Error("Invalid inert fixture RPC");
    return session(role, async () => (await db.query<{ value: T }>(`select public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) value`, values.map(value => value && typeof value === "object" ? JSON.stringify(value) : value))).rows[0]!.value);
  }
  beforeAll(async () => {
    db = await createTestDatabase();
    await installGenerativeStorageFixture(db);
    for (const path of ["candidates/logo_local_concepts.sql", "activation/logo_concepts_50_publication_adjudication.sql", "candidates/logo_local_refinements.sql"])
      await db.exec(await readFile(new URL(`../../supabase/${path}`, import.meta.url), "utf8"));
    await db.exec("alter table auth.users add column email_confirmed_at timestamptz, add column raw_app_meta_data jsonb not null default '{}'::jsonb; create table auth.refresh_tokens(id bigserial primary key,user_id text,revoked boolean not null default false)");
    await db.exec(await readFile(new URL("../../supabase/candidates/account_service_enrollment.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../../supabase/candidates/account_worker_enrollment.sql", import.meta.url), "utf8"));
    await db.exec(`create role ${operator} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role ${reporter} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public to ${operator},${reporter};
      grant execute on function public.claim_account_service_enrollment(integer),public.read_account_service_enrollment_claim(uuid,uuid),
       public.record_account_service_enrollment(uuid,uuid,text,text,text),public.finish_account_service_enrollment(uuid,uuid,text[]),
       public.provision_account_worker_enrollment(uuid,uuid,text,jsonb,text,text),public.adopt_account_worker_enrollment(uuid,uuid,text,jsonb,jsonb),
       public.reserve_account_worker_storage_actor(uuid,uuid,uuid,jsonb,text),public.register_account_worker_storage_actor(uuid,uuid,uuid,jsonb,text),public.prove_unprovisioned_account_worker_storage_actor(uuid,uuid,uuid,jsonb,text),public.revoke_account_worker_storage_actor(uuid,uuid,uuid,jsonb,text),
       public.read_account_worker_enrollment(uuid,uuid,text),public.suspend_account_worker_enrollment(uuid,uuid,text,text),public.resume_account_worker_enrollment(uuid,uuid,text),
       public.publish_account_worker_enrollment(uuid,uuid,text,text),public.verify_account_worker_enrollment(uuid,uuid,text,jsonb),
       public.disable_account_worker_enrollment(uuid,uuid,text),public.verify_account_worker_revocation(uuid,uuid,text) to ${operator};
      grant execute on function public.report_account_worker_process(jsonb,text,text,timestamptz) to ${reporter};
      grant execute on function public.get_account_worker_strategy_route(jsonb) to ${reporter};
      insert into fluid_private.account_enrollment_operators select rolname,oid from pg_roles where rolname='${operator}';`);
  }, 60_000);
  afterAll(async () => { await db?.exec("set session authorization postgres"); await db?.close(); });
  beforeEach(async () => { await db.exec("begin"); });
  afterEach(async () => { await db.exec("rollback; set session authorization postgres"); });

  async function account(owner = OWNER_A) {
    await db.query("insert into auth.users(id,email_confirmed_at) values($1,clock_timestamp())", [owner]);
    const claim = await rpc<Claim>("claim_account_service_enrollment", [120]);
    expect(claim.ownerId).toBe(owner);
    await rpc("record_account_service_enrollment", [claim.id, claim.leaseToken, "naming", "provisioning", null]);
    return claim;
  }
  async function approve() {
    const proofHash = (await db.query<{ value: string }>("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') value from pg_proc where oid='public.account_enrollment_managed_principal()'::regprocedure")).rows[0]!.value;
    const policyHash = (await db.query<{ value: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') value", [JSON.stringify(policy)])).rows[0]!.value;
    const profile: ApprovedWorkerProfile = { capability: "naming", profileId: "synthetic-naming-profile", providerBindingRef: "synthetic-provider-reference", modelVerificationReceipt: "synthetic-model-receipt",
      applicationOrigin: "https://www.embel.xyz", supabaseOrigin: "https://fricsfwqibyhemknqgyf.supabase.co", projectId: "prj_syntheticfixture", deploymentId: "dpl_syntheticfixture",
      sourceRevision: "a".repeat(40), artifactSha256: "b".repeat(64), managedProofSha256: proofHash,
      runtime: { node: process.versions.node, icu: process.versions.icu!, unicode: process.versions.unicode!, platform: "linux", arch: "x64" }, dispatchApproved: true,
      model: "gpt-6-luna", admissionContract: "hosted_owner_v1", providerBudgetVersion: 2, spendControl: "uncapped", policyIdentity: policyHash };
    await db.query("insert into fluid_private.account_worker_provider_approvals values($1,'openai','api.openai.com',$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour')", [profile.providerBindingRef, profile.model, profile.modelVerificationReceipt]);
    await db.query(`insert into fluid_private.account_worker_profile_approvals(profile_id,capability,profile,policies,provider_binding_ref,reporter_role_name,reporter_role_oid,approved_at,expires_at)
      select $1,'naming',$2::jsonb,$3::jsonb,$4,rolname,oid,clock_timestamp(),clock_timestamp()+interval '1 hour' from pg_roles where rolname=$5`,
    [profile.profileId, JSON.stringify(profile), JSON.stringify({ "naming.generate": policy }), profile.providerBindingRef, reporter]);
    return profile;
  }
  async function provision(claim: Claim, profile: ApprovedWorkerProfile) {
    return rpc<Binding>("provision_account_worker_enrollment", [claim.id, claim.leaseToken, profile.capability, profile, "synthetic-credential-reference", verifier]);
  }
  async function running(binding: Binding, receipt = "synthetic-process-running") {
    const observedAt = (await db.query<{ value: string }>("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') value")).rows[0]!.value;
    await rpc("report_account_worker_process", [binding, "running", receipt, observedAt], reporter);
    return { ...binding, receipt, observedAt, sourceRevision: "a".repeat(40), artifactSha256: "b".repeat(64), storageSessionId: null };
  }
  async function heartbeat(binding: Binding) {
    await rpc("report_naming_brain_worker_status", [policy, binding.deploymentId, binding.workerId, null, 120], binding.roleName);
    await rpc("report_account_worker_heartbeat", [binding, null], binding.roleName);
  }
  async function ready(claim: Claim, binding: Binding) {
    await heartbeat(binding);
    const proof = await running(binding);
    await rpc("publish_account_worker_enrollment", [claim.id, claim.leaseToken, "naming", proof.receipt]);
    await rpc("verify_account_worker_enrollment", [claim.id, claim.leaseToken, "naming", proof]);
  }
  async function approveOther(capability: "strategy" | "logo") {
    const naming = await approve();
    const common = Object.fromEntries(Object.entries(naming).filter(([key]) => !["capability", "model", "admissionContract", "policyIdentity", "providerBudgetVersion", "spendControl"].includes(key)));
    let profile: ApprovedWorkerProfile;
    let policies: Record<string, unknown>;
    if (capability === "strategy") {
      const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"] as const;
      policies = Object.fromEntries(operations.map(operation => [operation, guidedStrategyPolicy(operation)]));
      const identities: Record<string, string> = {};
      for (const operation of operations) {
        identities[operation] = (await db.query<{ value: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') value", [JSON.stringify(policies[operation])])).rows[0]!.value;
        await db.query("insert into fluid_private.strategy_runtime_policy(operation,policy,enabled) values($1,$2,true)", [operation, JSON.stringify(policies[operation])]);
      }

      profile = { ...common, profileId: "synthetic-strategy-profile", providerBindingRef: "synthetic-strategy-provider", capability, model: "gpt-6.1-sol", admissionContract: "hosted_strategy_owner_uncapped_v1", spendControl: "uncapped", policyIdentities: identities } as ApprovedWorkerProfile;
    } else {
      const model = "gpt-image-2.5-sunburst-2026-09-08";
      policies = Object.fromEntries(["identity.logo_concept", "identity.logo_refine"].map(operation => [operation,
        { operation, policyIdentity: "a".repeat(64), handlerVersion: "logo-image-v1", provider: "openai", model, engine: null, maxCostMicrousd: 100 }]));
      profile = { ...common, profileId: "synthetic-logo-profile", providerBindingRef: "synthetic-logo-provider", capability, model, admissionContract: "account_logo_operation", spendControl: "uncapped", storageIdentityRef: "synthetic-storage-identity",
        policyIdentities: { "identity.logo_concept": "a".repeat(64), "identity.logo_refine": "a".repeat(64) } } as ApprovedWorkerProfile;
    }
    await db.query("insert into fluid_private.account_worker_provider_approvals values($1,'openai','api.openai.com',$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour')", [profile.providerBindingRef, profile.model, profile.modelVerificationReceipt]);
    await db.query(`insert into fluid_private.account_worker_profile_approvals(profile_id,capability,profile,policies,provider_binding_ref,reporter_role_name,reporter_role_oid,approved_at,expires_at)
      select $1,$2,$3::jsonb,$4::jsonb,$5,rolname,oid,clock_timestamp(),clock_timestamp()+interval '1 hour' from pg_roles where rolname=$6`,
    [profile.profileId, capability, JSON.stringify(profile), JSON.stringify(policies), profile.providerBindingRef, reporter]);
    return { profile, policies };
  }

  it("installs no approval, worker login or live grants and removes hostile default ACLs", async () => {
    expect((await db.query("select count(*)::int n from fluid_private.account_worker_profile_approvals")).rows).toEqual([{ n: 0 }]);
    const access = (await db.query<{ table_ok: boolean; function_ok: boolean }>(`select
      has_table_privilege('fixture_production_acl_probe','fluid_private.account_worker_profile_approvals','SELECT,INSERT,UPDATE,DELETE') table_ok,
      has_function_privilege('fixture_production_acl_probe','public.provision_account_worker_enrollment(uuid,uuid,text,jsonb,text,text)','EXECUTE') function_ok`)).rows[0]!;
    expect(access).toEqual({ table_ok: false, function_ok: false });
    await expect(rpc("provision_account_worker_enrollment", [], "authenticated")).rejects.toBeDefined();
  });

  it("preserves genuine preexisting unmanaged Logo readiness independently of enrollment state", async () => {
    await db.query("insert into auth.users(id,email_confirmed_at) values($1,clock_timestamp())", [OWNER_B]);
    const role = "fluid_logo_worker_production_fixture", operation = "identity.logo_concept";
    const descriptor = { operation, policyIdentity: "a".repeat(64), handlerVersion: "logo-image-v1", provider: "openai", model: "gpt-image-2.5-sunburst-2026-09-08", engine: null, maxCostMicrousd: 100 };
    await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2", [OWNER_B, role]);
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,$2,$3,$4,$5,$6,$7,true)", [OWNER_B, operation, descriptor.policyIdentity, descriptor.handlerVersion, descriptor.provider, descriptor.model, descriptor.maxCostMicrousd]);
    await rpc("report_logo_worker_ready", ["synthetic-existing-worker", [descriptor], 90], role);
    expect((await db.query("select fluid_private.account_worker_owner_ready($1,'logo') gate,fluid_private.logo_operation_ready($1,$2) current,fluid_private.account_worker_legacy_logo_ready($1,$2) legacy", [OWNER_B, operation])).rows)
      .toEqual([{ gate: true, current: true, legacy: true }]);
  });

  it("refuses absent approvals and stale leases without creating a role", async () => {
    const claim = await account();
    await expect(provision(claim, { profileId: "missing" } as ApprovedWorkerProfile)).rejects.toMatchObject({ message: "account_worker_profile_unavailable" });
    const profile = await approve();
    await expect(provision({ ...claim, leaseToken: OWNER_B }, profile)).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select count(*)::int n from fluid_private.account_enrollment_managed_roles")).rows).toEqual([{ n: 0 }]);
  });

  it("creates exact managed roles idempotently, preserves legacy guards and isolates owners", async () => {
    const claim = await account(), profile = await approve(), binding = await provision(claim, profile);
    expect(binding.profileFingerprint).toBe(workerProfileFingerprint(profile));
    expect(binding.roleName).toBe(`fluid_naming_brain_worker_${OWNER_A.replaceAll("-", "")}`);
    expect(await provision(claim, profile)).toEqual(binding);
    expect(await rpc("adopt_account_worker_enrollment", [claim.id, claim.leaseToken, "naming", profile, binding])).toEqual(binding);
    expect(await rpc("account_enrollment_managed_principal", [], binding.roleName)).toMatchObject({ version: 2, ownerId: OWNER_A, roleOid: binding.roleOid });
    expect(await rpc("account_worker_observation_principal", [], binding.roleName)).toEqual(binding);
    await expect(rpc("adopt_account_worker_enrollment", [claim.id, claim.leaseToken, "naming", profile, { ...binding, ownerId: OWNER_B }])).rejects.toMatchObject({ message: "account_worker_binding_unavailable" });
    await expect(session(binding.roleName, () => db.query("select * from fluid_private.account_worker_bindings"))).rejects.toMatchObject({ code: "42501" });
    await expect(session(binding.roleName, () => db.query("select * from public.projects"))).rejects.toMatchObject({ code: "42501" });
    await expect(rpc("claim_naming_brain_job", [binding.workerId, binding.deploymentId, 60], binding.roleName)).rejects.toMatchObject({ message: "account_worker_not_ready" });
    const edge = (await db.query("select admin_option,inherit_option,set_option from pg_auth_members where roleid=$1", [binding.roleOid])).rows;
    expect(edge).toEqual([{ admin_option: true, inherit_option: false, set_option: false }]);
  });

  it("requires actual worker heartbeat and separately authorized running receipt before ready", async () => {
    const claim = await account(), profile = await approve(), binding = await provision(claim, profile);
    const proof = await running(binding);
    await expect(rpc("verify_account_worker_enrollment", [claim.id, claim.leaseToken, "naming", proof])).rejects.toMatchObject({ message: "account_worker_verification_unavailable" });
    await heartbeat(binding);
    await expect(rpc("verify_account_worker_enrollment", [claim.id, claim.leaseToken, "naming", proof])).rejects.toMatchObject({ message: "account_worker_publication_unavailable" });
    await rpc("publish_account_worker_enrollment", [claim.id, claim.leaseToken, "naming", proof.receipt]);
    expect(await rpc("verify_account_worker_enrollment", [claim.id, claim.leaseToken, "naming", proof])).toBe(true);
    await db.exec("update fluid_private.account_worker_heartbeats set expires_at=clock_timestamp()-interval '1 second'");
    await expect(rpc("claim_naming_brain_job", [binding.workerId, binding.deploymentId, 60], binding.roleName)).rejects.toMatchObject({ message: "account_worker_not_ready" });
    expect(await rpc("account_worker_observation_principal", [], binding.roleName)).toEqual(binding);
    await expect(rpc("report_account_worker_process", [binding, "running", "forged-operator-report", proof.observedAt])).rejects.toMatchObject({ code: "42501" });
    await expect(rpc("record_account_service_enrollment", [claim.id, claim.leaseToken, "naming", "ready", "forged-ready"])).rejects.toBeDefined();
    await db.query("insert into fluid_private.account_worker_approval_revocations(kind,reference) values('provider',$1)", [profile.providerBindingRef]);
    await expect(rpc("report_account_worker_heartbeat", [binding, null], binding.roleName)).rejects.toMatchObject({ code: "42501" });
  });

  it("permits only the exact trusted creator ADMIN edge for a newly registered launcher reporter", async () => {
    const claim = await account(), profile = await approve(), binding = await provision(claim, profile);
    await db.exec(`grant ${reporter} to postgres with admin true,inherit false,set false`);
    expect(await running(binding)).toHaveProperty("receipt", "synthetic-process-running");
    await db.exec(`grant ${reporter} to postgres with admin true,inherit true,set false`);
    await expect(running(binding, "unsafe-creator-report")).rejects.toMatchObject({ message: "account_worker_reporter_unavailable" });
  });

  it("maintains the same completed binding and refuses a speculative restart without a trusted stop and SQL quiescence", async () => {
    const claim = await account(), profile = await approve(), binding = await provision(claim, profile);
    await ready(claim, binding);
    const descriptor = { version: 1, binding, profile };
    const before = await rpc<{ descriptor: unknown; heartbeat: unknown; restartAllowed: boolean }>("read_account_worker_enrollment", [claim.id, claim.leaseToken, "naming"]);
    expect(before).toMatchObject({ descriptor, restartAllowed: false }); expect(before.heartbeat).not.toBeNull();
    await rpc("suspend_account_worker_enrollment", [claim.id, claim.leaseToken, "naming", "verification_unavailable"]);
    expect(await rpc("account_worker_observation_principal", [], binding.roleName)).toEqual(binding);
    await expect(rpc("claim_naming_brain_job", [binding.workerId, binding.deploymentId, 60], binding.roleName)).rejects.toMatchObject({ message: "account_worker_not_ready" });
    await expect(rpc("resume_account_worker_enrollment", [claim.id, claim.leaseToken, "naming"])).rejects.toMatchObject({ message: "account_worker_restart_unconfirmed" });
    const stoppedAt = (await db.query<{ value: string }>("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') value")).rows[0]!.value;
    await rpc("report_account_worker_process", [binding, "stopped", "synthetic-known-stop", stoppedAt], reporter);
    expect((await rpc<{ restartAllowed: boolean }>("read_account_worker_enrollment", [claim.id, claim.leaseToken, "naming"])).restartAllowed).toBe(false);
    await db.exec("update fluid_private.naming_worker_leadership set expires_at=clock_timestamp()-interval '1 second'");
    expect(await rpc("read_account_worker_enrollment", [claim.id, claim.leaseToken, "naming"])).toMatchObject({ descriptor, heartbeat: null, restartAllowed: true });
    expect(await rpc("resume_account_worker_enrollment", [claim.id, claim.leaseToken, "naming"])).toEqual(descriptor);
    await expect(rpc("claim_naming_brain_job", [binding.workerId, binding.deploymentId, 60], binding.roleName)).rejects.toMatchObject({ message: "account_worker_not_ready" });
    await heartbeat(binding);
    const proof = await running(binding, "synthetic-restarted-process");
    expect(await rpc("verify_account_worker_enrollment", [claim.id, claim.leaseToken, "naming", proof])).toBe(true);
    expect((await db.query("select role_oid,operation_key from fluid_private.account_enrollment_managed_roles where owner_id=$1 and capability='naming'", [OWNER_A])).rows)
      .toEqual([{ role_oid: binding.roleOid, operation_key: binding.operationKey }]);
    expect((await db.query("select publication_receipt from fluid_private.account_service_enrollment_steps where enrollment_id=$1 and capability='naming'", [claim.id])).rows)
      .toEqual([{ publication_receipt: "synthetic-process-running" }]);
  });

  it("fences changed manager memberships and immutable approval rewrites", async () => {
    const claim = await account(), profile = await approve(), binding = await provision(claim, profile);
    await db.exec(`grant ${binding.roleName} to ${reporter} with admin false, inherit false, set false`);
    await expect(rpc("account_worker_observation_principal", [], binding.roleName)).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("update fluid_private.account_worker_profile_approvals set profile='{}'")).rejects.toMatchObject({ message: "immutable_worker_enrollment_approval" });
  });

  it("excludes an explicitly registered Storage service actor before confirmation without excluding customer signups", async () => {
    await account();
    const actor = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await db.query("insert into auth.users(id) values($1)", [actor]);
    await db.query("select fluid_private.account_worker_register_storage_actor($1,$2,'synthetic-storage-identity','synthetic-actor-registration',clock_timestamp()+interval '1 hour')", [actor, OWNER_A]);
    await db.query("update auth.users set email_confirmed_at=clock_timestamp() where id=$1", [actor]);
    expect((await db.query("select owner_id from fluid_private.account_service_enrollments order by owner_id")).rows).toEqual([{ owner_id: OWNER_A }]);
    expect((await db.query("select fluid_private.account_worker_storage_actor_active($1) value", [actor])).rows).toEqual([{ value: true }]);
    await db.query("insert into auth.users(id,email_confirmed_at) values($1,clock_timestamp())", [OWNER_B]);
    expect((await db.query("select count(*)::int n from fluid_private.account_service_enrollments")).rows).toEqual([{ n: 2 }]);
    await expect(db.query("select fluid_private.account_worker_register_storage_actor($1,$2,'late-identity','late-receipt',clock_timestamp()+interval '1 hour')", [OWNER_B, OWNER_A]))
      .rejects.toMatchObject({ message: "account_worker_service_actor_unavailable" });
  });

  it("lease-registers only a reserved Admin-created unconfirmed actor and replays the exact receipt after confirmation", async () => {
    const claim = await account(), { profile } = await approveOther("logo");
    if (profile.capability !== "logo") throw Error("Synthetic Logo profile missing");
    await rpc("record_account_service_enrollment", [claim.id, claim.leaseToken, "logo", "provisioning", null]);
    const actor = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", reservationRef = "synthetic-reserved-storage-credential";
    const operationKey = claim.steps.find(step => step.capability === "logo")!.operationKey;
    const metadata = { version: 1, enrollmentId: claim.id, ownerId: OWNER_A, generation: claim.generation, operationKey,
      storageIdentityRef: profile.storageIdentityRef, reservationRef };
    const reserved = await rpc("reserve_account_worker_storage_actor", [claim.id, claim.leaseToken, actor, profile, reservationRef]);
    expect(reserved).toHaveProperty("authUserId", actor);
    await db.query("insert into auth.users(id,raw_app_meta_data) values($1,$2)", [actor, JSON.stringify({ embel_worker_storage: { ...metadata, ownerId: OWNER_B } })]);
    await expect(rpc("register_account_worker_storage_actor", [claim.id, claim.leaseToken, actor, profile, reservationRef])).rejects.toMatchObject({ message: "account_worker_service_actor_metadata_unavailable" });
    await db.query("update auth.users set raw_app_meta_data=$2 where id=$1", [actor, JSON.stringify({ embel_worker_storage: metadata })]);
    await expect(rpc("register_account_worker_storage_actor", [claim.id, OWNER_B, actor, profile, reservationRef])).rejects.toMatchObject({ code: "42501" });
    const registered = await rpc("register_account_worker_storage_actor", [claim.id, claim.leaseToken, actor, profile, reservationRef]);
    expect(registered).toEqual({ ownerId: OWNER_A, generation: claim.generation, revision: claim.revision, operationKey, authUserId: actor,
      storageIdentityRef: profile.storageIdentityRef, receipt: reservationRef });
    await db.query("update auth.users set email_confirmed_at=clock_timestamp() where id=$1", [actor]);
    expect(await rpc("register_account_worker_storage_actor", [claim.id, claim.leaseToken, actor, profile, reservationRef])).toEqual(registered);
    await expect(rpc("register_account_worker_storage_actor", [claim.id, claim.leaseToken, actor, profile, "other-reservation"])).rejects.toMatchObject({ message: "account_worker_service_actor_reservation_unavailable" });
    const foreign = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await db.query("insert into auth.users(id,raw_app_meta_data) values($1,$2)", [foreign, JSON.stringify({ embel_worker_storage: { ...metadata, ownerId: OWNER_B } })]);
    // A different profile reference avoids the exact existing-registration replay.
    await expect(rpc("register_account_worker_storage_actor", [claim.id, claim.leaseToken, foreign, profile, reservationRef])).rejects.toMatchObject({ message: "account_worker_service_actor_reservation_unavailable" });
    expect((await db.query("select count(*)::int n from fluid_private.account_service_actors")).rows).toEqual([{ n: 1 }]);
    expect((await db.query("select owner_id from fluid_private.account_service_enrollments")).rows).toEqual([{ owner_id: OWNER_A }]);
  });

  it.each(["vault_only", "reserved_only", "created_unregistered", "registered", "confirmed"] as const)("cleans the exact %s actor failure without inventing a stopped process", async phase => {
    const claim = await account(), { profile } = await approveOther("logo");
    if (profile.capability !== "logo") throw Error("Synthetic Logo profile missing");
    await rpc("record_account_service_enrollment", [claim.id, claim.leaseToken, "logo", "provisioning", null]);
    const actor = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ref = "synthetic-failed-actor-reservation";
    const operationKey = claim.steps.find(step => step.capability === "logo")!.operationKey;
    const created = phase !== "vault_only" && phase !== "reserved_only";
    if (phase !== "vault_only") await rpc("reserve_account_worker_storage_actor", [claim.id, claim.leaseToken, actor, profile, ref]);
    if (created) await db.query("insert into auth.users(id,raw_app_meta_data) values($1,$2)", [actor, JSON.stringify({ embel_worker_storage: {
      version: 1, enrollmentId: claim.id, ownerId: OWNER_A, generation: claim.generation, operationKey, storageIdentityRef: profile.storageIdentityRef, reservationRef: ref,
    } })]);
    if (phase === "registered" || phase === "confirmed") await rpc("register_account_worker_storage_actor", [claim.id, claim.leaseToken, actor, profile, ref]);
    if (phase === "confirmed") {
      await db.query("update auth.users set email_confirmed_at=clock_timestamp() where id=$1", [actor]);
      await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [sessionId, actor]);
      await db.query("insert into auth.refresh_tokens(user_id,revoked) values($1,false)", [actor.toUpperCase()]);
    }
    await db.exec("alter table auth.users add column banned_until timestamptz");
    await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [OWNER_A]);
    const revoke = await rpc<Claim>("claim_account_service_enrollment", [120]);
    await expect(rpc("prove_unprovisioned_account_worker_storage_actor", [claim.id, claim.leaseToken, actor, profile, ref])).rejects.toMatchObject({ code: "42501" });
    const proof = await rpc<Record<string, unknown>>("prove_unprovisioned_account_worker_storage_actor", [revoke.id, revoke.leaseToken, actor, profile, ref]);
    expect(proof).toEqual({ ownerId: OWNER_A, generation: revoke.generation, revision: revoke.revision, operationKey, authUserId: actor,
      storageIdentityRef: profile.storageIdentityRef, receipt: ref, scope: "never_provisioned", authorityAbsent: true, storageDenied: true,
      authUserAbsent: !created, registered: phase === "registered" || phase === "confirmed", sessionsAbsent: phase !== "confirmed", refreshTokensAbsent: phase !== "confirmed" });
    expect(proof).not.toHaveProperty("runtimeStopped");
    if (!created) await expect(session("postgres", () => db.query("insert into auth.users(id) values($1)", [actor])))
      .rejects.toMatchObject({ message: "account_worker_service_actor_retired" });
    await expect(rpc("prove_unprovisioned_account_worker_storage_actor", [revoke.id, revoke.leaseToken, sessionId, profile, ref])).rejects.toMatchObject({ message: "account_worker_service_actor_conflict" });
    await expect(rpc("prove_unprovisioned_account_worker_storage_actor", [revoke.id, revoke.leaseToken, actor, profile, "foreign-ref"])).rejects.toMatchObject({ message: "account_worker_service_actor_conflict" });
    if (created) {
      await expect(rpc("verify_account_worker_revocation", [revoke.id, revoke.leaseToken, "logo"])).rejects.toMatchObject({ message: "account_worker_actor_retirement_unconfirmed" });
      // Explicit inert stand-in for acknowledged global logout/ban, not a live
      // Admin operation. Historical revoked refresh rows remain as evidence.
      await db.query("delete from auth.sessions where user_id=$1", [actor]);
      await db.query("update auth.refresh_tokens set revoked=true where lower(user_id)=$1", [actor]);
      await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 year' where id=$1", [actor]);
    }
    const retired = await rpc<Record<string, unknown>>("verify_account_worker_revocation", [revoke.id, revoke.leaseToken, "logo"]);
    expect(retired).toMatchObject({ ownerId: OWNER_A, generation: revoke.generation, revision: revoke.revision, operationKey,
      capability: "logo", authorityDisabled: true, storageDenied: true, scope: "never_provisioned", authorityAbsent: true });
    expect(retired).not.toHaveProperty("runtimeStopped");
    expect((await db.query("select count(*)::int n from fluid_private.account_enrollment_managed_roles")).rows).toEqual([{ n: 0 }]);
  });

  it.each(["strategy", "logo"] as const)("installs actual %s owner/policy/storage bindings without borrowing another lane's role", async capability => {
    const claim = await account(), { profile, policies } = await approveOther(capability);
    await rpc("record_account_service_enrollment", [claim.id, claim.leaseToken, capability, "provisioning", null]);
    const actor = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    if (capability === "logo") {
      await db.query("insert into auth.users(id) values($1)", [actor]);
      await db.query("select fluid_private.account_worker_register_storage_actor($1,$2,'synthetic-storage-identity','synthetic-actor',clock_timestamp()+interval '1 hour')", [actor, OWNER_A]);
      await db.query("update auth.users set email_confirmed_at=clock_timestamp() where id=$1", [actor]);
    }
    const binding = await provision(claim, profile);
    expect(binding.profileFingerprint).toBe(workerProfileFingerprint(profile));
    expect(binding.storageAuthUserId).toBe(capability === "logo" ? actor : null);
    expect(await rpc("account_worker_observation_principal", [], binding.roleName)).toEqual(binding);
    expect((await db.query("select count(*)::int n from fluid_private.account_enrollment_managed_roles where owner_id=$1", [OWNER_A])).rows).toEqual([{ n: 1 }]);
    if (capability === "strategy") {
      expect((await db.query("select count(*)::int n from fluid_private.api_strategy_bindings where owner_id=$1 and role_oid=$2 and enabled", [OWNER_A, binding.roleOid])).rows).toEqual([{ n: 4 }]);
      await expect(rpc("claim_api_text_job", [OWNER_B, binding.workerId, 60, "a".repeat(64), binding.deploymentId], binding.roleName)).rejects.toMatchObject({ message: "account_worker_not_ready" });
      await expect(rpc("read_account_worker_strategy_step", [OWNER_B, OWNER_B, OWNER_B, "foreign"], binding.roleName)).rejects.toMatchObject({ code: "42501" });
      await expect(session(binding.roleName, () => db.query("select state from public.job_steps"))).rejects.toMatchObject({ code: "42501" });
      const missingMessage = { version: 1, jobId: OWNER_B, policyIdentity: "a".repeat(64), deploymentId: binding.deploymentId, dispatchIdentity: "b".repeat(64) };
      expect(await rpc("get_account_worker_strategy_route", [missingMessage], reporter)).toBeNull();
      await expect(rpc("get_account_worker_strategy_route", [missingMessage])).rejects.toMatchObject({ code: "42501" });
      expect(await rpc("get_account_worker_strategy_route", [{ ...missingMessage, ownerId: OWNER_A }], reporter)).toBeNull();
    } else {
      expect(await rpc("report_logo_worker_ready", [binding.workerId, Object.values(policies), 90], binding.roleName)).toBe(true);
      expect((await db.query("select owner_id,enabled from fluid_private.logo_storage_principals where auth_user_id=$1", [actor])).rows).toEqual([{ owner_id: OWNER_A, enabled: true }]);
      await expect(rpc("claim_logo_job", [binding.workerId, 60], binding.roleName)).rejects.toMatchObject({ message: "account_worker_not_ready" });
      const project = (await brainRpc<{ id: string }>(db, "create_project", ["complete_brand", "Synthetic unavailable logo", { description: "Offline unavailable source" }, "a".repeat(64)])).id;
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_A]);
      await expect(rpc("account_logo_operation", [project, "admit", {}], "authenticated")).rejects.toMatchObject({ message: "account_worker_not_ready" });
      expect((await db.query("select count(*)::int n from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ n: 0 }]);
    }
  });

  it("locks the actual login only after a separately reported drained stop and persists the revocation witness", async () => {
    const claim = await account(), profile = await approve(), binding = await provision(claim, profile);
    await ready(claim, binding);
    await db.exec("alter table auth.users add column banned_until timestamptz");
    await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [OWNER_A]);
    const revoke = await rpc<Claim>("claim_account_service_enrollment", [120]);
    await rpc("disable_account_worker_enrollment", [revoke.id, revoke.leaseToken, "naming"]);
    expect((await db.query("select rolcanlogin from pg_roles where oid=$1", [binding.roleOid])).rows).toEqual([{ rolcanlogin: true }]);
    await expect(rpc("verify_account_worker_revocation", [revoke.id, revoke.leaseToken, "naming"])).rejects.toMatchObject({ message: "account_worker_revocation_unconfirmed" });
    const stoppedAt = (await db.query<{ value: string }>("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') value")).rows[0]!.value;
    await rpc("report_account_worker_process", [binding, "stopped", "synthetic-process-stopped", stoppedAt], reporter);
    expect(await rpc("verify_account_worker_revocation", [revoke.id, revoke.leaseToken, "naming"])).toMatchObject({ ownerId: OWNER_A, authorityDisabled: true, runtimeStopped: true, storageDenied: true });
    expect((await db.query("select rolcanlogin from pg_roles where oid=$1", [binding.roleOid])).rows).toEqual([{ rolcanlogin: false }]);
    await expect(rpc("account_worker_observation_principal", [], binding.roleName)).rejects.toMatchObject({ code: "42501" });
  });

  it.each(["fresh", "existing"] as const)("uses the existing uncapped Logo witness with a %s unfunded ledger", async ledger => {
    const claim = await account(), { profile, policies } = await approveOther("logo");
    await rpc("record_account_service_enrollment", [claim.id, claim.leaseToken, "logo", "provisioning", null]);
    const actor = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", storageSessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await db.query("insert into auth.users(id) values($1)", [actor]);
    await db.query("select fluid_private.account_worker_register_storage_actor($1,$2,'synthetic-storage-identity','synthetic-storage-actor',clock_timestamp()+interval '1 hour')", [actor, OWNER_A]);
    await db.query("update auth.users set email_confirmed_at=clock_timestamp() where id=$1", [actor]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [storageSessionId, actor]);
    if (ledger === "existing") await db.query("insert into public.usage_accounts(owner_id,limit_microusd,spent_microusd,provider_actual_microusd) values($1,3,7,11)", [OWNER_A]); // Explicit offline state; initialization must preserve it.
    const binding = await provision(claim, profile);
    await rpc("report_logo_worker_ready", [binding.workerId, Object.values(policies), 90], binding.roleName);
    await rpc("report_account_worker_heartbeat", [binding, storageSessionId], binding.roleName);
    const proof = { ...await running(binding), storageSessionId };
    await rpc("publish_account_worker_enrollment", [claim.id, claim.leaseToken, "logo", proof.receipt]);
    await rpc("verify_account_worker_enrollment", [claim.id, claim.leaseToken, "logo", proof]);
    const workspace = logoWorkspaceV2Schema.parse(await brainRpc(db, "start_logo_project", [{ requestKey: randomUUID(), brief: {
      name: "Synthetic managed logo", activity: "Offline testing", audience: "Testers", personality: "Calm", logoTypes: ["wordmark"],
    } }]));
    const brief = workspace.stages.brief_references!;
    const snapshot = (await db.query<{ id: string }>("select reference_snapshot_id id from public.logo_stage_revisions where id=$1", [brief.id])).rows[0]!.id;
    const quote = logoCostQuoteSchema.parse(await brainRpc(db, "account_logo_operation", [workspace.projectId, "quote", { operation: "concepts", expected: workspace.heads, briefRevisionId: brief.id, referenceSnapshotId: snapshot }]));
    const input = { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: workspace.heads };
    if (ledger === "fresh") expect((await db.query("select count(*)::int n from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ n: 0 }]);
    const saved = logoDispatchReceiptSchema.parse(await brainRpc(db, "account_logo_operation", [workspace.projectId, "admit", input]));
    expect((await db.query("select limit_microusd,spent_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ limit_microusd: ledger === "fresh" ? 0 : 3, spent_microusd: ledger === "fresh" ? 0 : 7, provider_actual_microusd: ledger === "fresh" ? 0 : 11 }]);
    expect(saved.jobIds).toHaveLength(6);
    expect((await db.query("select count(*)::int n from fluid_private.logo_local_jobs where owner_id=$1 and role_oid=$2", [OWNER_A, binding.roleOid])).rows).toEqual([{ n: 6 }]);
    expect((await db.query<{ value: boolean }>("select reserved_microusd>limit_microusd value from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0]!.value).toBe(true);
    const claimed = await session(binding.roleName, () => db.query("select * from public.claim_logo_job($1,60)", [binding.workerId]));
    expect(claimed.rows).toHaveLength(1);
    await db.exec("alter table auth.users add column banned_until timestamptz");
    await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [OWNER_A]);
    const revoke = await rpc<Claim>("claim_account_service_enrollment", [120]);
    await rpc("disable_account_worker_enrollment", [revoke.id, revoke.leaseToken, "logo"]);
    expect(logoDispatchReceiptSchema.parse(await brainRpc(db, "account_logo_operation", [workspace.projectId, "admit", input]))).toEqual(saved);
    expect((await db.query("select enabled from fluid_private.logo_storage_principals where auth_user_id=$1", [actor])).rows).toEqual([{ enabled: false }]);
  });

  it("retains an already-issued paid Naming receipt after ban while closing new dispatch and publication", async () => {
    const claim = await account(), profile = await approve(), binding = await provision(claim, profile);
    await ready(claim, binding);
    const project = (await brainRpc<{ id: string }>(db, "create_project", ["naming_only", "Synthetic managed drain", { description: "Offline receipt retention" }, "a".repeat(64)])).id;
    await brainRpc(db, "save_naming_preferences", [project, 0, brainPreferences]);
    const database = { query: (sql: string, values: unknown[] = []) => session(binding.roleName, () => db.query<Record<string, unknown>>(sql, values)) };
    const store = new NamingBrainJobStore(database, binding.deploymentId, () => ({ deploymentId: binding.deploymentId, workerId: binding.workerId, generation: 1 }));
    expect(await store.attestPendingPreferences()).toBe(1);
    expect((await db.query("select count(*)::int n from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ n: 0 }]);
    await brainRpc(db, "ensure_hosted_naming_brain_run", [project, initialIntent("synthetic-managed-drain")]);
    expect((await db.query("select limit_microusd,spent_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ limit_microusd: 0, spent_microusd: 0, provider_actual_microusd: 0 }]);
    const job = await store.claim(binding.workerId, 120); expect(job).not.toBeNull();
    const input = namingBrainJobInputSchema.parse(normalizeNamingStoredJson(job!.input));
    await store.registerPlan(job!, [{ key: "creation", maximumCostMicrousd: 1_500_000 }, { key: "prepare", maximumCostMicrousd: 0 }]);
    await store.beginStep(job!, "creation", 1_500_000);
    const request = createNamingRoleRequest({ runId: input.runId, stageKey: "creation", providerCallKey: "context.research.researcher",
      input: { role: "researcher", snapshot: input.snapshot }, dependencyArtifactIds: [], policy: createProgressiveNamingRolePolicy(input.policy, "researcher", undefined, undefined, true, 5) });
    await store.saveProgressiveCallPlan(job!, "context.research", [request]);
    await store.authorizeDispatch(job!, request);
    await db.exec("alter table auth.users add column banned_until timestamptz");
    await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [OWNER_A]);
    const revoke = await rpc<Claim>("claim_account_service_enrollment", [120]);
    await rpc("disable_account_worker_enrollment", [revoke.id, revoke.leaseToken, "naming"]);
    expect(await rpc("account_worker_observation_principal", [], binding.roleName)).toEqual(binding);
    await expect(rpc("account_enrollment_managed_principal", [], binding.roleName)).rejects.toMatchObject({ code: "42501" });
    const receipt = namingProviderReceiptSchema.parse({ version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents", budgetControl: "local_unlimited_v1", localPipelineVersion: 2,
      runId: input.runId, stageKey: "creation", role: "researcher", snapshotHash: input.snapshot.snapshotHash, providerCallKey: request.providerCallKey,
      assignmentKey: null, requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents, dispatchState: "dispatched",
      requestId: "synthetic-late-request", sessionId: "synthetic-late-session", turnId: "synthetic-late-turn", agentId: "synthetic-late-agent", responseId: null,
      callIds: [], observedModel: profile.model, toolCalls: [], artifactItemIds: [], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [],
      accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: new Date().toISOString() });
    expect(await store.recordReceipt(job!, receipt)).toMatchObject({ requestId: "synthetic-late-request" });
    await expect(store.authorizeDispatch(job!, request)).rejects.toMatchObject({ message: "account_worker_not_ready" });
    await expect(rpc("naming_brain_worker_action", [job!.id, job!.leaseToken, "publish_microbatch", {}], binding.roleName)).rejects.toMatchObject({ message: "account_worker_not_ready" });
    expect((await db.query("select rolcanlogin from pg_roles where oid=$1", [binding.roleOid])).rows).toEqual([{ rolcanlogin: true }]);
    await expect(rpc("verify_account_worker_revocation", [revoke.id, revoke.leaseToken, "naming"])).rejects.toMatchObject({ message: "account_worker_revocation_unconfirmed" });
  });
});
