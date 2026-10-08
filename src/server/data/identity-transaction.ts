import "server-only";
import { z } from "zod";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { contextSnapshotSchema } from "@/domain/projects";
import { identityReferenceSnapshotSchema } from "@/domain/identity-references";
import { collectIdentityBatchResult, identityGeneratedSystemBindingSchema } from "@/domain/identity-jobs";
import {
  createIdentityInputSnapshot, getIdentityFreshness, initialIdentityPreferences,
  identityComponentChangeSchema, identityPreferenceRevisionSchema, identityPreferencesSchema,
  identityProjectSchema, identityRefinementResponseSchema, identitySelectionSchema,
  identitySessionSchema, identitySystemAssetSchema, identitySystemVersionSchema,
  refineIdentityComponent as buildRefinement, refineIdentityComponentSchema,
  selectIdentitySystem as buildSelection, selectIdentitySystemResponseSchema, selectIdentitySystemSchema,
  validateIdentityRefinement,
  type IdentityRefinementResponse, type RefineIdentityComponent,
  type SelectIdentitySystem, type SelectIdentitySystemResponse,
} from "@/domain/project-identity";

/** A server-owned injected DB capability. No URL/env/Pool, worker or network callback. */
export interface IdentityTransactionConnection {
  query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  /** Adapter must remove a discarded connection from its pool, never reuse it. */
  release(discard: boolean): void | Promise<void>;
  /** Idempotent hard discard if release/reset fails; never return this lease. */
  discard(): void | Promise<void>;
}
export type IdentityConnectionBinding = { ownerId: string; roleName: string; roleOid: number };
export interface IdentityConnectionFactory {
  /** Must use bounded DB acquisition and honor abort, cleaning any late lease. */
  acquire(verifiedOwnerId: string, signal?: AbortSignal): Promise<{ connection: IdentityTransactionConnection; binding: IdentityConnectionBinding }>;
}
const bindingSchema = z.strictObject({ ownerId: z.uuid(), roleName: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), roleOid: z.number().int().positive().max(4_294_967_295) });
const principalSchema = z.strictObject({ sessionUserName: z.string(), sessionUserOid: z.number().int().positive(), boundOwnerId: z.uuid() });
const recordSchema = z.strictObject({ system: identitySystemVersionSchema, rootSystemId: z.uuid(), base: z.uuid().nullable(), change: identityComponentChangeSchema.nullable(), selection: identitySelectionSchema.nullable() });
const rootSourceSchema = z.strictObject({
  systemVersionId: z.uuid(), job: z.strictObject({ id: z.uuid(), ownerId: z.uuid(), projectId: z.uuid(), operation: z.literal("identity.image"), inputRevision: z.number().int().positive() }),
  context: contextSnapshotSchema, referenceSnapshot: identityReferenceSnapshotSchema,
  preferencesRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), preferences: identityPreferencesSchema,
});
const fileSchema = z.strictObject({ systemVersionId: z.uuid(), slot: z.number().int().min(0).max(48), component: z.enum(["logo","colors","typography","graphics","imagery","composition"]).nullable(), role: z.string(), asset: identitySystemAssetSchema });
const proofSchema = z.strictObject({
  records: z.array(recordSchema).max(1024), roots: z.array(identityGeneratedSystemBindingSchema).max(48),
  rootSources: z.array(rootSourceSchema).max(48), files: z.array(fileSchema).max(50_176),
  batches: z.array(z.strictObject({ batchId: z.uuid(), acceptedRootCount: z.number().int().min(1).max(3) })).max(48),
});
const common = { version: z.literal(1), principal: principalSchema, projectId: z.uuid(), ownerId: z.uuid(), proofs: proofSchema };
const preparedSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("new"), project: identityProjectSchema, session: identitySessionSchema.nullable(), preferences: identityPreferenceRevisionSchema.nullable(),
    referenceSnapshot: identityReferenceSnapshotSchema, previousSelection: identitySelectionSchema.nullable(), targetSystemId: z.uuid(),
    selectionId: z.uuid(), systemVersionId: z.uuid(), changeId: z.uuid(), now: z.iso.datetime({ offset: true }).max(64), reason: z.enum(["selected","restored"]),
  }),
  z.strictObject({ ...common, kind: z.literal("replay"), intent: refineIdentityComponentSchema, response: identityRefinementResponseSchema }),
]);
type Prepared = z.infer<typeof preparedSchema>;
type Operation = "selection" | "refinement";
type Request = SelectIdentitySystem | RefineIdentityComponent;
export type IdentityCommitRecovery =
  | { operation: "refinement"; action: "replay_same_intent"; request: RefineIdentityComponent }
  | { operation: "selection"; action: "read_before_explicit_retry"; request: SelectIdentitySystem };
/** Never serialize the original request implicitly. Editor keeps its own observed intent.
 * The same refinement key remains required; selection must first reconcile by reading. */
export class IdentityUncertainCommitError extends ApiError {
  readonly recovery: IdentityCommitRecovery;
  constructor(operation: Operation, request: Request) {
    super("integration_unavailable");
    this.name = "IdentityUncertainCommitError";
    this.recovery = operation === "refinement"
      ? { operation, action: "replay_same_intent", request: structuredClone(request as RefineIdentityComponent) }
      : { operation, action: "read_before_explicit_retry", request: structuredClone(request as SelectIdentitySystem) };
  }
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function requireStored(condition: boolean): asserts condition { if (!condition) throw new ApiError("integration_unavailable"); }
function conflict(condition: boolean): asserts condition { if (!condition) throw new ApiError("conflict"); }
function parseStored<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new ApiError("integration_unavailable"); return result.data; }
function canonicalRequest(operation: Operation, value: unknown): Request {
  const key = operation === "selection" ? "systemVersionId" : "baseSystemVersionId";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    value = { ...value };
    const body = value as Record<string, unknown>;
    if (typeof body[key] === "string" && z.uuid().safeParse(body[key]).success) body[key] = body[key].toLowerCase();
  }
  const result = operation === "selection" ? selectIdentitySystemSchema.safeParse(value) : refineIdentityComponentSchema.safeParse(value);
  if (!result.success || new TextEncoder().encode(JSON.stringify(result.data)).length > 32_768) throw new ApiError("invalid_input");
  return result.data;
}
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new ApiError("integration_unavailable"); }
function mapError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "P0002") return new ApiError("not_found");
  if (["PT409","23505","40001"].includes(code)) return new ApiError("conflict");
  if (["22023","23514","22P02"].includes(code)) return new ApiError("invalid_input");
  return new ApiError("integration_unavailable");
}
function verifyPrincipal(prepared: Prepared, binding: IdentityConnectionBinding, owner: string, project: string): void {
  if (prepared.ownerId !== owner || prepared.projectId !== project || prepared.principal.boundOwnerId !== owner) throw new ApiError("not_found");
  requireStored(prepared.principal.sessionUserName === binding.roleName && prepared.principal.sessionUserOid === binding.roleOid);
}
/** Shared strict parsing also runs WHATWG URL checks and full Naming provenance replay. */
function verifyProofs(prepared: Prepared): Map<string, z.infer<typeof recordSchema>> {
  const { proofs, ownerId: owner, projectId: project } = prepared;
  const records = new Map(proofs.records.map(row => [row.system.id, row]));
  const roots = new Map(proofs.roots.map(row => [row.system.id, row]));
  const sources = new Map(proofs.rootSources.map(row => [row.systemVersionId, row]));
  requireStored(records.size === proofs.records.length && roots.size === proofs.roots.length && sources.size === proofs.rootSources.length && sources.size === roots.size);
  const verified = new Set<string>(), visiting = new Set<string>();
  function verify(id: string): void {
    if (verified.has(id)) return;
    requireStored(!visiting.has(id)); visiting.add(id);
    const row = records.get(id); requireStored(!!row && row.system.ownerId === owner && row.system.projectId === project);
    const files = proofs.files.filter(file => file.systemVersionId === id).sort((a,b) => a.slot-b.slot);
    const expectedFiles = [{ component: null, role: "board", asset: row.system.board.asset }, ...row.system.productionFiles];
    requireStored(files.length === expectedFiles.length);
    files.forEach((file,index) => requireStored(file.slot === index && same({ component: file.component, role: file.role, asset: file.asset }, expectedFiles[index])));
    if (row.system.source.kind === "generated") {
      const root = roots.get(id), source = sources.get(id);
      requireStored(!!root && !!source && row.rootSystemId === id && row.base === null && row.change === null && row.selection === null && same(root.system,row.system));
      requireStored(source.job.id === root.batch.jobId && source.job.ownerId === owner && source.job.projectId === project && source.job.inputRevision === row.system.input.projectRevision);
      const frozen = row.system.input;
      requireStored(same(frozen.context,source.context) && same(frozen.referenceSnapshot,source.referenceSnapshot) && frozen.preferencesRevision === source.preferencesRevision && same(frozen.preferences,source.preferences));
      requireStored(source.preferencesRevision !== 0 || same(source.preferences,initialIdentityPreferences(source.context)));
    } else {
      requireStored(row.base === row.system.source.baseSystemVersionId && row.base !== null);
      verify(row.base); verify(row.rootSystemId);
      requireStored(records.get(row.base)!.rootSystemId === row.rootSystemId);
      try { validateIdentityRefinement({ base: records.get(row.base)!.system, system: row.system, change: row.change, selection: row.selection }); }
      catch { throw new ApiError("integration_unavailable"); }
    }
    visiting.delete(id); verified.add(id);
  }
  for (const id of records.keys()) verify(id);
  requireStored(proofs.files.every(file => records.has(file.systemVersionId)));
  const batches = new Map(proofs.batches.map(row => [row.batchId,row.acceptedRootCount]));
  requireStored(batches.size === proofs.batches.length);
  for (const [batchId,count] of batches) {
    const bindings = proofs.roots.filter(root => root.batch.id === batchId);
    requireStored(bindings.length === count);
    try { collectIdentityBatchResult(bindings[0]!.batch,bindings); }
    catch { throw new ApiError("integration_unavailable"); }
  }
  requireStored(proofs.roots.every(root => batches.has(root.batch.id) && records.has(root.system.id)));
  return records;
}
function buildProposal(prepared: Prepared, operation: Operation, request: Request) {
  const records = verifyProofs(prepared);
  if (prepared.kind === "replay") {
    conflict(operation === "refinement" && same(prepared.intent,request));
    const response = prepared.response;
    const record = records.get(response.system.id), intent = request as RefineIdentityComponent;
    requireStored(!!record && same(record.system,response.system) && same(record.change,response.change) && same(record.selection,response.selection));
    requireStored(response.change.baseSystemVersionId === intent.baseSystemVersionId && response.change.component === intent.component && same(response.change.after,intent.input));
    // Replay fences bind the original immutable receipt, never today's head.
    requireStored(response.selection.identityRevision === intent.expectedIdentityRevision + 1 && response.selection.projectRevision === intent.expectedProjectRevision
      && response.selection.referenceRevision === intent.expectedReferenceRevision && response.selection.preferencesRevision === intent.expectedPreferencesRevision
      && (!response.selection.acceptedEarlierBasis || intent.acceptEarlierBasis));
    return { replay: true as const, response };
  }
  requireStored(prepared.project.id === prepared.projectId && prepared.project.owner_id === prepared.ownerId);
  const owned = (value: { ownerId: string; projectId: string }) => value.ownerId === prepared.ownerId && value.projectId === prepared.projectId;
  requireStored(owned(prepared.referenceSnapshot) && (!prepared.session || owned(prepared.session)) && (!prepared.preferences || owned(prepared.preferences)) && (!prepared.previousSelection || owned(prepared.previousSelection)));
  const preferencesRevision = prepared.preferences?.revision ?? 0, identityRevision = prepared.session?.identityRevision ?? 0;
  requireStored((prepared.session?.currentPreferencesRevision ?? 0) === preferencesRevision && (prepared.session?.currentSelectionId ?? null) === (prepared.previousSelection?.id ?? null) && (prepared.previousSelection?.identityRevision ?? 0) === identityRevision);
  conflict(request.expectedProjectRevision === prepared.project.current_revision && request.expectedReferenceRevision === prepared.referenceSnapshot.referenceRevision && request.expectedPreferencesRevision === preferencesRevision && request.expectedIdentityRevision === identityRevision);
  const targetId = operation === "selection" ? (request as SelectIdentitySystem).systemVersionId : (request as RefineIdentityComponent).baseSystemVersionId;
  requireStored(prepared.targetSystemId === targetId);
  const target = records.get(targetId)?.system; if (!target) throw new ApiError("not_found");
  let currentInput;
  try { currentInput = createIdentityInputSnapshot({ ownerId: prepared.ownerId, projectId: prepared.projectId, scope: prepared.project.scope, projectRevision: prepared.project.current_revision,
    context: prepared.project.context, referenceSnapshot: prepared.referenceSnapshot, preferencesRevision, preferences: prepared.preferences?.preferences ?? initialIdentityPreferences(prepared.project.context), capturedAt: prepared.now }); }
  catch { throw new ApiError("conflict"); }
  const args = { actorId: prepared.ownerId, projectId: prepared.projectId, currentInput, previousSelection: prepared.previousSelection, identityRevision, selectionId: prepared.selectionId, now: prepared.now, request };
  try {
    if (operation === "refinement") {
      const edit = request as RefineIdentityComponent;
      if (same(target.components[edit.component],edit.input)) throw new ApiError("invalid_input");
      const response = buildRefinement({ ...args, base: target, systemVersionId: prepared.systemVersionId, changeId: prepared.changeId });
      return { replay: false as const, proposal: { version: 1, kind: "refinement", currentInput, response }, response };
    }
    const selection = buildSelection({ ...args, system: target, reason: prepared.reason });
    const session = identitySessionSchema.parse({ ownerId: prepared.ownerId, projectId: prepared.projectId, identityRevision: selection.identityRevision, currentSelectionId: selection.id, currentPreferencesRevision: preferencesRevision, createdAt: prepared.session?.createdAt ?? prepared.now, updatedAt: prepared.now });
    const response = selectIdentitySystemResponseSchema.parse({ session, currentSelection: { selection, system: target, freshness: getIdentityFreshness(target.input.basis,{ status: "available", basis: currentInput.basis }) } });
    return { replay: false as const, proposal: { version: 1, kind: "selection", currentInput, response }, response };
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError("conflict"); }
}

/** Fixed DB-only flow, no user-supplied callback while locks are held. */
export function createIdentityTransactionService(factory: IdentityConnectionFactory | null) {
  async function run(operation: Operation, auth: Pick<AuthenticatedContext,"userId">, projectId: string, value: unknown, signal?: AbortSignal): Promise<SelectIdentitySystemResponse | IdentityRefinementResponse> {
    if (!z.uuid().safeParse(auth.userId).success) throw new ApiError("unauthenticated");
    if (!z.uuid().safeParse(projectId).success) throw new ApiError("not_found");
    const owner = auth.userId.toLowerCase(), project = projectId.toLowerCase(), request = canonicalRequest(operation,value);
    aborted(signal); if (!factory) throw new ApiError("integration_unavailable");
    let connection: IdentityTransactionConnection | undefined, began = false, commitStarted = false, committed = false, discard = false;
    let result: SelectIdentitySystemResponse | IdentityRefinementResponse | undefined, failure: ApiError | undefined;
    try {
      const acquired = await factory.acquire(owner,signal); connection = acquired.connection;
      const binding = parseStored(bindingSchema,acquired.binding);
      if (binding.ownerId !== owner) throw new ApiError("not_found");
      aborted(signal); began = true; await connection.query("BEGIN");
      await connection.query("SET LOCAL statement_timeout = '5000ms'");
      await connection.query("SET LOCAL lock_timeout = '1500ms'");
      await connection.query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
      const login = await connection.query("SELECT session_user::text AS role_name, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid");
      const row = parseStored(z.strictObject({ role_name: z.string(), role_oid: z.coerce.number().int().positive() }),login.rows[0]);
      requireStored(row.role_name === binding.roleName && row.role_oid === binding.roleOid);
      // The trusted helper independently checks this expected claim against its
      // administrative session_user OID/name binding; SET LOCAL alone is no trust.
      await connection.query("SELECT pg_catalog.set_config('request.jwt.claim.sub',$1,true)",[owner]);
      aborted(signal);
      const preparedResult = await connection.query("SELECT fluid_private.prepare_identity_transaction($1::uuid,$2::jsonb,$3::boolean) AS value",[project,JSON.stringify(request),operation === "refinement"]);
      requireStored(new TextEncoder().encode(JSON.stringify(preparedResult.rows)).length <= 16 * 1024 * 1024);
      const preparedRow = parseStored(z.strictObject({ value: z.unknown() }),preparedResult.rows[0]);
      const prepared = parseStored(preparedSchema,preparedRow.value); verifyPrincipal(prepared,binding,owner,project);
      aborted(signal); const built = buildProposal(prepared,operation,request); aborted(signal);
      if (!built.replay) {
        const commitResult = await connection.query("SELECT fluid_private.commit_identity_transaction($1::uuid,$2::jsonb,$3::jsonb) AS value",[project,JSON.stringify(request),JSON.stringify(built.proposal)]);
        const commitRow = parseStored(z.strictObject({ value: z.unknown() }),commitResult.rows[0]);
        const receipt = operation === "selection" ? parseStored(selectIdentitySystemResponseSchema,commitRow.value) : parseStored(identityRefinementResponseSchema,commitRow.value);
        requireStored(same(receipt,built.response));
      }
      aborted(signal); commitStarted = true; await connection.query("COMMIT"); committed = true;
      // Even replay COMMIT acknowledgment is required before returning success.
      if (signal?.aborted) throw new IdentityUncertainCommitError(operation,request);
      result = built.response;
    } catch (error) {
      discard = commitStarted;
      failure = commitStarted ? new IdentityUncertainCommitError(operation,request) : mapError(error);
      if (connection && began && !committed) {
        try { await connection.query("ROLLBACK"); } catch { discard = true; }
      }
    } finally {
      if (connection) {
        try { await connection.release(discard); }
        catch {
          try { await connection.discard(); } catch { /* Adapter must quarantine failed disposal; never retry writes. */ }
          failure = committed || commitStarted ? new IdentityUncertainCommitError(operation,request) : new ApiError("integration_unavailable");
        }
      }
    }
    if (failure) throw failure;
    // Release may await pool cleanup. An abort there cannot deliver success.
    if (signal?.aborted) throw committed ? new IdentityUncertainCommitError(operation,request) : new ApiError("integration_unavailable");
    requireStored(result !== undefined); return result;
  }
  return {
    select: (auth: Pick<AuthenticatedContext,"userId">,projectId: string,value: unknown,signal?: AbortSignal) => run("selection",auth,projectId,value,signal) as Promise<SelectIdentitySystemResponse>,
    refine: (auth: Pick<AuthenticatedContext,"userId">,projectId: string,value: unknown,signal?: AbortSignal) => run("refinement",auth,projectId,value,signal) as Promise<IdentityRefinementResponse>,
  };
}
/** Production has no approved connection capability. No env lookup or worker reuse. */
export const productionIdentityTransactions = createIdentityTransactionService(null);
export const productionIdentitySaveAvailability = { status: "unavailable", reason: "trusted_transaction_unavailable" } as const;
