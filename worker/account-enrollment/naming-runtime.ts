import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { PoolConfig } from "pg";
import { z } from "zod";
import { namingBrainJobInputSchema, namingBrainPolicySchema, type NamingBrainPolicy } from "../../src/domain/naming-brain";
import type { ClaimedJob } from "../../src/domain/jobs";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import type { NamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import type { createNamingReferenceReader } from "../../src/server/ai/naming-brain/source-reader";
import { NamingContinuationUnavailableError } from "../../src/server/ai/naming-brain/continuation";
import { NamingBrainJobStore, type NamingMaintenanceAuthority } from "../naming-brain-store";
import { createNamingBrainHandlers } from "../handlers/naming-brain";
import type { JobDatabase } from "../postgres-store";
import { runOneJob } from "../runner";
import { startNamingWorkerAuthority, type NamingWorkerAuthority } from "../../services/naming-worker/authority";
import { runNamingPolling } from "../../services/naming-worker/scheduling";
import type { OwnerWorkerProcessDescriptor } from "./adapter";
import { approvedWorkerProfileSchema, ownerWorkerRole, ownerWorkerRuntimeSchema, workerProfileFingerprint } from "./configuration";
import type { OwnerWorkerArtifactAttestation, OwnerWorkerDatabaseSecret, OwnerWorkerProviderSecret, OwnerWorkerReadyNotice } from "./process-contracts";
import { assertOwnerWorkerArtifact, ownerWorkerPoolOptions, createOwnerWorkerPool, qualifyOwnerWorkerPool } from "./process-qualification";

export type OwnerNamingRuntimeSecrets = Readonly<{ database: OwnerWorkerDatabaseSecret; provider: OwnerWorkerProviderSecret;
  policy: NamingBrainPolicy; attestation: OwnerWorkerArtifactAttestation }>;
const unavailable = () => new Error("owner_naming_runtime_unavailable");
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const bindingSchema = z.strictObject({ ownerId: z.uuid(), generation: z.number().int().positive(), revision: z.number().int().positive(), operationKey: z.uuid(), capability: z.literal("naming"),
  roleName: z.string().min(1).max(63), roleOid: z.number().int().positive().max(4_294_967_295), credentialRef: reference,
  workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/u), deploymentId: z.string().regex(/^dpl_[A-Za-z0-9_-]{1,196}$/u),
  profileFingerprint: digest, storageAuthUserId: z.null() });
const secretsSchema = z.strictObject({ database: z.strictObject({ databaseUrl: z.string().min(1).max(8192), caPem: z.string().min(80).max(65_536) }),
  provider: z.strictObject({ apiKey: z.string().min(16).max(500).regex(/^\S+$/u), model: z.string().min(1).max(150), modelVerificationReceipt: reference }),
  policy: namingBrainPolicySchema,
  attestation: z.strictObject({ sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u), sourceClean: z.literal(true), artifactSha256: digest, deploymentId: z.string().min(1).max(200), runtime: ownerWorkerRuntimeSchema }) });
export type QualifiedOwnerNamingConfiguration = Readonly<{ descriptor: OwnerWorkerProcessDescriptor; secrets: OwnerNamingRuntimeSecrets; poolOptions: PoolConfig }>;

/** Pure startup validation. The child controller supplies an attestation derived
 * from its actual bundle/manifest, not browser data or invented platform env. */
export function qualifyOwnerNamingRuntime(descriptor: OwnerWorkerProcessDescriptor, secrets: OwnerNamingRuntimeSecrets): QualifiedOwnerNamingConfiguration {
  try {
    if (descriptor.version !== 1) throw unavailable();
    const profile = approvedWorkerProfileSchema.parse(descriptor.profile), binding = bindingSchema.parse(descriptor.binding), resolved = secretsSchema.parse(secrets);
    if (profile.capability !== "naming" || binding.roleName !== ownerWorkerRole("naming", binding.ownerId)
      || binding.profileFingerprint !== workerProfileFingerprint(profile) || binding.deploymentId !== profile.deploymentId
      || resolved.provider.model !== profile.model || resolved.provider.modelVerificationReceipt !== profile.modelVerificationReceipt || resolved.policy.model !== profile.model
      || resolved.attestation.sourceRevision !== profile.sourceRevision || resolved.attestation.artifactSha256 !== profile.artifactSha256
      || resolved.attestation.deploymentId !== profile.deploymentId || !isDeepStrictEqual(resolved.attestation.runtime, profile.runtime)
      || process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") throw unavailable();
    const qualified = { version: 1 as const, binding, profile };
    assertOwnerWorkerArtifact(qualified, resolved.attestation);
    return { descriptor: qualified, secrets: resolved, poolOptions: ownerWorkerPoolOptions(qualified, resolved.database) };
  } catch { throw unavailable(); }
}

const managedPrincipalSchema = z.strictObject({ version: z.literal(2), ownerId: z.uuid(), generation: z.number().int().positive(), revision: z.number().int().positive(), capability: z.literal("naming"),
  operationKey: z.uuid(), roleName: z.string(), roleOid: z.number().int().positive(), managerRoleName: z.literal("embel_account_role_manager"), managerRoleOid: z.number().int().positive(), identityHelperOwnerQualified: z.boolean() });
async function assertEnrollment(database: JobDatabase, descriptor: OwnerWorkerProcessDescriptor) {
  const result = await database.query("select public.account_enrollment_managed_principal() proof"), binding = descriptor.binding;
  if (result.rows.length !== 1) throw unavailable();
  const proof = managedPrincipalSchema.parse(result.rows[0]!.proof);
  if (proof.ownerId !== binding.ownerId || proof.generation !== binding.generation || proof.revision !== binding.revision || proof.operationKey !== binding.operationKey
    || proof.roleName !== binding.roleName || proof.roleOid !== binding.roleOid) throw unavailable();
}
export const OWNER_NAMING_FUNCTIONS = Object.freeze([
  "public.account_enrollment_managed_principal()", "public.report_naming_brain_worker_status(jsonb,text,text,bigint,integer)",
  "public.report_account_worker_heartbeat(jsonb,uuid)",
  "public.naming_brain_worker_maintenance_v2(text,text,bigint,text,jsonb)", "public.naming_brain_worker_action(uuid,uuid,text,jsonb)",
  "public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)", "public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)",
  "public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)",
]);

/** Used only inside the actual restricted connection's read-only transaction.
 * Catalog reads and a pinned own-session proof need no private-table SELECT. */
export async function verifyOwnerNamingSession(database: JobDatabase, configuration: QualifiedOwnerNamingConfiguration): Promise<void> {
  const { binding, profile } = configuration.descriptor;
  if (profile.capability !== "naming") throw unavailable();
  try {
    const identity = await database.query(`select session_user,current_user,current_database() database,r.oid::bigint role_oid,
      r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolconnlimit,
      exists(select 1 from pg_catalog.pg_auth_members where member=r.oid) has_memberships,
      exists(select 1 from pg_catalog.pg_shdepend where refclassid='pg_catalog.pg_authid'::regclass and refobjid=r.oid and deptype='o') owns_objects
      from pg_catalog.pg_roles r where r.rolname=session_user`);
    const role = identity.rows[0];
    if (identity.rows.length !== 1 || role?.session_user !== binding.roleName || role.current_user !== binding.roleName || role.database !== "postgres"
      || Number(role.role_oid) !== binding.roleOid || role.rolcanlogin !== true || role.rolconnlimit !== 4
      || [role.rolinherit, role.rolsuper, role.rolbypassrls, role.rolcreatedb, role.rolcreaterole, role.rolreplication, role.has_memberships, role.owns_objects].some(value => value !== false)) throw unavailable();
    const helper = await database.query(`select p.prosecdef,p.provolatile,p.proretset,p.pronargs,p.pronargdefaults,l.lanname,
      p.proconfig,p.proleakproof,pg_get_userbyid(p.proowner) owner_name,pg_catalog.pg_get_function_result(p.oid) result_type,
      encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_sha256,
      not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.privilege_type='EXECUTE' and (a.grantee=0 or a.grantee in(select oid from pg_roles where rolname in('anon','authenticated','service_role')))) public_execution_denied,
      has_function_privilege(session_user,p.oid,'EXECUTE') callable
      from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
      where p.oid=to_regprocedure('public.account_enrollment_managed_principal()')`);
    const proofFunction = helper.rows[0];
    if (helper.rows.length !== 1 || proofFunction?.prosecdef !== true || proofFunction.provolatile !== "s" || proofFunction.proretset !== false
      || proofFunction.pronargs !== 0 || proofFunction.pronargdefaults !== 0 || proofFunction.lanname !== "plpgsql" || proofFunction.result_type !== "jsonb"
      || proofFunction.owner_name !== "postgres" || proofFunction.proleakproof !== false || proofFunction.public_execution_denied !== true
      || !isDeepStrictEqual(proofFunction.proconfig, ['search_path=""']) || proofFunction.body_sha256 !== profile.managedProofSha256 || proofFunction.callable !== true) throw unavailable();
    await assertEnrollment(database, configuration.descriptor);
    const permissions = await database.query(`select count(*)::integer found,coalesce(bool_and(has_function_privilege(session_user,p.oid,'EXECUTE')),false) available
      from unnest($1::text[]) signature join pg_catalog.pg_proc p on p.oid=to_regprocedure(signature)`, [OWNER_NAMING_FUNCTIONS]);
    if (permissions.rows.length !== 1 || permissions.rows[0]?.found !== OWNER_NAMING_FUNCTIONS.length || permissions.rows[0]?.available !== true) throw unavailable();
    const policy = await database.query("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') policy_identity", [JSON.stringify(configuration.secrets.policy)]);
    if (policy.rows.length !== 1 || policy.rows[0]?.policy_identity !== profile.policyIdentity) throw unavailable();
  } catch { throw unavailable(); }
}

/** Refuses local/capped/foreign claims before any handler or provider work. A
 * rejected lease remains durable for ordinary SQL recovery; never rewrite it. */
export class OwnerNamingJobStore extends NamingBrainJobStore {
  constructor(database: JobDatabase, private readonly ownerId: string, deploymentId: string, authority: () => NamingMaintenanceAuthority | null,
    private readonly enrollmentGuard: () => Promise<void>) {
    super(database, deploymentId, authority); z.uuid().parse(ownerId);
  }
  override executionAuthority(job: ClaimedJob): "hosted_owner_v1" {
    const authority = super.executionAuthority(job), input = namingBrainJobInputSchema.parse(job.input);
    if (job.ownerId !== this.ownerId || authority !== "hosted_owner_v1" || input.executionAuthority !== "hosted_owner_v1"
      || input.providerBudgetVersion !== 2 || input.localPipelineVersion !== 2 || input.localTimingVersion !== 2) throw unavailable();
    return authority;
  }
  override async claim(workerId: string, leaseSeconds: number) {
    const job = await super.claim(workerId, leaseSeconds); if (job) this.executionAuthority(job); return job;
  }
  override async assertContinuation(job: ClaimedJob) {
    try { await this.enrollmentGuard(); } catch { throw new NamingContinuationUnavailableError(); }
    await super.assertContinuation(job);
  }
}

/** Concrete engine composition, also usable with an inert SDK protocol in
 * offline tests. This does not qualify a process or publish readiness. */
export function createOwnerNamingExecutor(options: { database: JobDatabase; ownerId: string; deploymentId: string; workerId: string; apiKey: string;
  authority: () => NamingMaintenanceAuthority | null; assertEnrollment: () => Promise<void>; assertReady: () => Promise<void>; protocol?: NamingManagedProtocol;
  referenceReader?: ReturnType<typeof createNamingReferenceReader> }) {
  const store = new OwnerNamingJobStore(options.database, options.ownerId, options.deploymentId, options.authority, options.assertEnrollment);
  const handlers = createNamingBrainHandlers({ store, apiKey: options.apiKey, assertReady: options.assertReady,
    ...(options.protocol ? { runtime: (job: ClaimedJob) => createNamingAgentRuntime({ protocol: options.protocol!, referenceReader: options.referenceReader, localPrototype: store.hasUnmeteredExecutionAuthority(job),
      model: namingBrainJobInputSchema.parse(job.input).policy.model, persistence: store.runtimePersistence(job), assertContinuation: () => store.assertContinuation(job) }) } : {}) });
  return { store, handlers, runJob: (signal: AbortSignal) => runOneJob({ store, handlers, workerId: options.workerId, signal, abortGraceMs: 15_000 }) };
}

/** Dedicated child-process bootstrap. The supervisor resolves process-only
 * secrets/real artifact attestation and owns termination; this entry never
 * provisions a role, reads platform credentials or supplies local authority. */
export async function runOwnerNamingRuntime(options: { descriptor: OwnerWorkerProcessDescriptor; secrets: OwnerNamingRuntimeSecrets; signal: AbortSignal;
  onReady?: (notice: OwnerWorkerReadyNotice) => void | Promise<void> }): Promise<void> {
  const config = qualifyOwnerNamingRuntime(options.descriptor, options.secrets);
  if (options.signal.aborted) throw unavailable();
  const pool = createOwnerWorkerPool(config.descriptor, config.secrets.database);
  const controller = new AbortController(), stop = () => controller.abort();
  options.signal.addEventListener("abort", stop, { once: true });
  let authority: NamingWorkerAuthority | undefined;
  try {
    await qualifyOwnerWorkerPool(pool, config.descriptor, controller.signal);
    const client = await pool.connect(); let transaction = false, failure: Error | undefined;
    try {
      await client.query("BEGIN READ ONLY"); transaction = true;
      await verifyOwnerNamingSession(client, config);
    } catch { failure = unavailable(); }
    finally { if (transaction) try { await client.query("ROLLBACK"); } catch { failure = unavailable(); } client.release(failure); }
    if (failure || controller.signal.aborted) throw unavailable();
    const { binding } = config.descriptor;
    const executor = createOwnerNamingExecutor({ database: pool, ownerId: binding.ownerId, deploymentId: binding.deploymentId, workerId: binding.workerId,
      apiKey: config.secrets.provider.apiKey, authority: () => { const lease = authority?.current(); return lease ? { workerId: binding.workerId, generation: lease.generation } : null; },
      assertEnrollment: () => assertEnrollment(pool, config.descriptor),
      assertReady: async () => { if (controller.signal.aborted || !authority) throw unavailable(); await assertEnrollment(pool, config.descriptor); await authority.assertReady(); if (controller.signal.aborted) throw unavailable(); } });
    authority = await startNamingWorkerAuthority({ signal: controller.signal,
      report: async generation => {
        await assertEnrollment(pool, config.descriptor);
        const status = await executor.store.reportWorkerStatus(config.secrets.policy, binding.workerId, generation);
        if (status.leader && status.ready) {
          const heartbeat = await pool.query("select public.report_account_worker_heartbeat($1::jsonb,null::uuid) ready", [JSON.stringify(binding)]);
          if (heartbeat.rows.length !== 1 || heartbeat.rows[0]?.ready !== true) throw unavailable();
        }
        return status;
      } });
    await authority.assertReady();
    if (!authority.current() || controller.signal.aborted) throw unavailable();
    await options.onReady?.({ workerId: binding.workerId, roleOid: binding.roleOid, observedAt: new Date().toISOString(), storageSessionId: null });
    if (controller.signal.aborted) return;
    const gate = authority;
    await runNamingPolling({ signal: controller.signal, generation: () => gate.current()?.generation ?? null,
      attestPreferences: () => executor.store.attestPendingPreferences(), expireLeases: () => executor.store.expireLeases(binding.workerId), runJob: () => executor.runJob(controller.signal) });
  } catch { throw unavailable(); } finally {
    stop();
    try { await authority?.stop(); }
    finally { try { await pool.end(); } finally { options.signal.removeEventListener("abort", stop); } }
  }
}
