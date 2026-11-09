import "server-only";
import { z } from "zod";
import {
  accountNamesPageSchema, createBrandFromProjectNameResponseSchema, createBrandFromProjectNameSchema,
  importProjectNameResponseSchema, importProjectNameSchema, listAccountNamesSchema, listNamingBatchesSchema,
  listProjectNamesSchema, nameIdentityKey, nameTransformSchema, namingStrategyBasis, namingStrategyBasisSchema,
  namingStrategyKeyFromBasis, projectNamePageSchema, projectNameResponseSchema, selectProjectNameResponseSchema, selectProjectNameSchema,
  updateNameRetentionResponseSchema,
  updateNameRetentionSchema, updateNamingPreferencesResponseSchema, updateNamingPreferencesSchema,
  updateNamingViewStateResponseSchema, updateNamingViewStateSchema, validateProjectNameTransformParents,
  type ProjectNameCandidate,
} from "@/domain/project-naming";
import { projectNamingOverviewSchema } from "@/domain/naming-jobs";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("invalid_input");
  return parsed.data;
}
function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  return parsed.data;
}
function id(value: string): string { if (!z.uuid().safeParse(value).success) throw new ApiError("not_found"); return value; }
function databaseError(error: { code?: unknown; message?: unknown } | null): void {
  if (!error) return;
  if (error.code === "PT409" && error.message === "naming_history_capacity") throw new ApiError("naming_history_capacity");
  if (["P0002", "PGRST116"].includes(String(error.code))) throw new ApiError("not_found");
  if (["PT409", "23505", "40001"].includes(String(error.code))) throw new ApiError("conflict");
  if (["22023", "23514", "23502", "22P02"].includes(String(error.code))) throw new ApiError("invalid_input");
  throw new ApiError("integration_unavailable");
}
/** JSONB has no object key order. A strategy key is derived display data, never
 * authorization. Every nested owner field must name the signed-in account. */
export function normalizeNamingRows(value: unknown, ownerId: string): unknown {
  if (Array.isArray(value)) return value.map(item => normalizeNamingRows(item, ownerId));
  if (!value || typeof value !== "object") return value;
  const row = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeNamingRows(child, ownerId)]));
  if (("ownerId" in row && row.ownerId !== ownerId) || ("owner_id" in row && row.owner_id !== ownerId)) throw new ApiError("not_found");
  if (row.strategyBasis) row.strategyKey = namingStrategyKeyFromBasis(stored(namingStrategyBasisSchema, row.strategyBasis));
  return row;
}
async function rpc<T>(auth: AuthenticatedContext, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await auth.client.rpc(name, args);
  databaseError(error);
  return stored(schema, normalizeNamingRows(data, auth.userId));
}
function scope(auth: AuthenticatedContext, projectId: string, row: { ownerId: string; projectId: string }): void {
  if (row.ownerId !== auth.userId || row.projectId !== projectId) throw new ApiError("not_found");
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function invariant(condition: boolean): asserts condition { if (!condition) throw new ApiError("integration_unavailable"); }
function ancestry(candidate: ProjectNameCandidate) {
  const origin = candidate.origin;
  return origin.kind === "generated" || origin.kind === "brainstorm" || origin.kind === "local_import" ? { root: origin, history: [] } : { root: origin.root, history: origin.history };
}

/**
 * Generated names (brainstorm and the retired generated origins) are written only
 * by owner-checked definer SQL, so they need only the account and project scope.
 * Workshop and copied names keep user-editable lineage: before rendering or using
 * it, replay V1 and bind every root, transform, parent and Blend input to owned
 * immutable rows. Cache this bounded graph per request.
 */
class CandidateVerifier {
  private readonly candidates = new Map<string, ProjectNameCandidate>();
  private readonly checked = new Set<string>();
  private readonly visiting = new Set<string>();
  private readonly transforms = new Map<string, z.infer<typeof nameTransformSchema>>();
  constructor(private readonly auth: AuthenticatedContext) {}
  async candidate(projectId: string, candidateId: string, supplied?: ProjectNameCandidate): Promise<ProjectNameCandidate> {
    const key = `${id(projectId)}:${id(candidateId)}`;
    if (supplied) {
      scope(this.auth, projectId, supplied); invariant(supplied.id === candidateId);
      if (this.candidates.has(key)) invariant(equal(this.candidates.get(key), supplied));
      else { invariant(this.candidates.size < 10_000); this.candidates.set(key, supplied); }
    }
    if (!this.candidates.has(key)) {
      // A bounded response graph fails closed rather than silently dropping ancestry.
      invariant(this.candidates.size < 10_000);
      const response = await rpc(this.auth, "get_project_name", { p_project_id: projectId, p_candidate_id: candidateId }, projectNameResponseSchema);
      scope(this.auth, projectId, response.entry.candidate); invariant(response.entry.candidate.id === candidateId);
      this.candidates.set(key, response.entry.candidate);
    }
    const candidate = this.candidates.get(key)!;
    if (this.checked.has(key)) return candidate;
    invariant(!this.visiting.has(key)); this.visiting.add(key);
    try {
      // Brainstorm and generated rows need no replay: scope was checked when the
      // row was read, and the schema binds their origin to this candidate.
      const origin = candidate.origin;
      if (origin.kind === "local_import") {
        invariant(equal(namingStrategyBasis(origin.capturedContext), candidate.strategyBasis));
      } else if (origin.kind === "account_copy") {
        const source = await this.candidate(origin.sourceProjectId, origin.sourceCandidateId);
        invariant(source.value === candidate.value && source.identityKey === candidate.identityKey && source.rationale === candidate.rationale && source.caution === candidate.caution);
        invariant(equal(ancestry(source), { root: origin.root, history: origin.history }) && equal(source.strategyBasis, candidate.strategyBasis));
        const revision = await this.auth.client.from("project_revisions").select("project_id,owner_id,revision")
          .eq("project_id", origin.sourceProjectId).eq("owner_id", this.auth.userId).eq("revision", origin.sourceContextRevision).maybeSingle();
        databaseError(revision.error);
        const row = stored(z.object({ project_id: z.uuid(), owner_id: z.uuid(), revision: z.number().int().positive() }), revision.data);
        if (row.owner_id !== this.auth.userId || row.project_id !== origin.sourceProjectId) throw new ApiError("not_found");
        invariant(row.revision === origin.sourceContextRevision);
      } else if (origin.kind === "transform") {
        const parent = await this.candidate(projectId, origin.parentCandidateId);
        const secondary = origin.secondaryCandidateId ? await this.candidate(projectId, origin.secondaryCandidateId) : undefined;
        const last = origin.history.at(-1)!;
        invariant(equal(ancestry(parent), { root: origin.root, history: origin.history.slice(0, -1) }));
        invariant(equal(parent.strategyBasis, candidate.strategyBasis) && parent.contextRevision === candidate.contextRevision);
        const transform = await this.transform(projectId, origin.transformId);
        invariant(transform.parentCandidateId === parent.id && transform.secondaryCandidateId === (secondary?.id ?? null));
        invariant(equal(transform.input, last.input) && transform.createdAt === last.createdAt && last.projectId === projectId);
        const item = transform.outputs.find(row => row.candidateId === candidate.id);
        invariant(item !== undefined && item.value === candidate.value && item.explanation === candidate.rationale && candidate.caution === undefined);
        try { validateProjectNameTransformParents({ parentCandidateId: parent.id, ...(secondary ? { secondaryCandidateId: secondary.id } : {}), input: transform.input, idempotencyKey: "immutable-history-check" }, parent, secondary); }
        catch { throw new ApiError("integration_unavailable"); }
      }
      this.checked.add(key);
      return candidate;
    } finally { this.visiting.delete(key); }
  }
  private async transform(projectId: string, transformId: string) {
    const key = `${projectId}:${transformId}`;
    if (!this.transforms.has(key)) {
      const row = await rpc(this.auth, "get_project_name_transform", { p_project_id: projectId, p_transform_id: transformId }, nameTransformSchema);
      scope(this.auth, projectId, row); invariant(row.id === transformId);
      this.transforms.set(key, row);
    }
    return this.transforms.get(key)!;
  }
}

export async function getProjectNaming(auth: AuthenticatedContext, projectId: string, query?: unknown) {
  id(projectId);
  const response = await rpc(auth, "get_project_naming", { p_project_id: projectId, p_query: query === undefined ? {} : input(listProjectNamesSchema, query) }, projectNamingOverviewSchema);
  if (response.project.id !== projectId || response.project.owner_id !== auth.userId) throw new ApiError("not_found");
  const verifier = new CandidateVerifier(auth);
  for (const { candidate } of response.candidates.items) await verifier.candidate(projectId, candidate.id, candidate);
  if (response.currentSelection) await verifier.candidate(projectId, response.currentSelection.candidate.id, response.currentSelection.candidate);
  return response;
}

/** Manual names have their own bounded page: generation's chronological feed never contains imports. */
export async function getCustomProjectNames(auth: AuthenticatedContext, projectId: string, value: unknown = {}) {
  id(projectId);
  const query = input(listNamingBatchesSchema, value);
  const project = await auth.client.from("projects").select("id,owner_id").eq("id", projectId).eq("owner_id", auth.userId).maybeSingle();
  databaseError(project.error);
  if (!project.data || project.data.id !== projectId || project.data.owner_id !== auth.userId) throw new ApiError("not_found");
  let read = auth.client.from("name_candidates").select("id,owner_id,project_id,value,identity_key,context_revision,strategy_basis,origin,rationale,caution,created_at")
    .eq("owner_id", auth.userId).eq("project_id", projectId).eq("origin->>kind", "local_import")
    .order("created_at", { ascending: true }).order("id", { ascending: true });
  if (query.cursor) {
    // Both values are schema-validated; PostgREST's tuple equivalent retains microsecond order.
    read = read.or(`created_at.gt.${query.cursor.createdAt},and(created_at.eq.${query.cursor.createdAt},id.gt.${query.cursor.id})`);
  }
  const result = await read.limit(query.limit + 1);
  databaseError(result.error);
  const rows = stored(z.array(z.object({ id: z.uuid(), owner_id: z.uuid(), project_id: z.uuid(), value: z.string(), identity_key: z.string(), context_revision: z.number().int().positive(), strategy_basis: z.unknown(), origin: z.unknown(), rationale: z.string(), caution: z.string().nullable(), created_at: z.iso.datetime({ offset: true }) })).max(query.limit + 1), result.data);
  if (rows.some(row => row.owner_id !== auth.userId || row.project_id !== projectId)) throw new ApiError("not_found");
  const visible = rows.slice(0, query.limit), ids = visible.map(row => row.id);
  const retained = ids.length ? await auth.client.from("name_retention").select("owner_id,project_id,candidate_id,revision,liked,saved,updated_at")
    .eq("owner_id", auth.userId).eq("project_id", projectId).in("candidate_id", ids) : { data: [], error: null };
  databaseError(retained.error);
  const retentions = stored(z.array(z.object({ owner_id: z.uuid(), project_id: z.uuid(), candidate_id: z.uuid(), revision: z.number().int().positive(), liked: z.boolean(), saved: z.boolean(), updated_at: z.iso.datetime({ offset: true }) })).max(query.limit), retained.data);
  if (retentions.some(row => row.owner_id !== auth.userId || row.project_id !== projectId || !ids.includes(row.candidate_id)) || new Set(retentions.map(row => row.candidate_id)).size !== retentions.length) throw new ApiError("not_found");
  const verifier = new CandidateVerifier(auth);
  const items: z.infer<typeof projectNameResponseSchema>["entry"][] = [];
  for (const row of visible) {
    const retention = retentions.find(item => item.candidate_id === row.id);
    const entry = stored(projectNameResponseSchema, normalizeNamingRows({ entry: {
      candidate: { id: row.id, ownerId: row.owner_id, projectId: row.project_id, value: row.value, identityKey: row.identity_key, contextRevision: row.context_revision, strategyBasis: row.strategy_basis, origin: row.origin, rationale: row.rationale, ...(row.caution === null ? {} : { caution: row.caution }), createdAt: row.created_at },
      retention: { ownerId: auth.userId, projectId, candidateId: row.id, revision: retention?.revision ?? 0, favorite: retention?.liked ?? false, saved: retention?.saved ?? false, updatedAt: retention?.updated_at ?? null },
    } }, auth.userId)).entry;
    invariant(entry.candidate.origin.kind === "local_import");
    await verifier.candidate(projectId, row.id, entry.candidate);
    items.push(entry);
  }
  const last = items.at(-1)?.candidate;
  return stored(projectNamePageSchema, { ownerId: auth.userId, projectId, items, nextCursor: rows.length > query.limit && last ? { id: last.id, createdAt: last.createdAt } : null });
}
export async function saveNamingPreferences(auth: AuthenticatedContext, projectId: string, value: unknown) {
  id(projectId);const parsed = input(updateNamingPreferencesSchema, value);
  const response = await rpc(auth, "save_naming_preferences", { p_project_id: projectId, p_expected_version: parsed.expectedPreferencesVersion, p_preferences: parsed.preferences }, updateNamingPreferencesResponseSchema);
  scope(auth, projectId, response.session);invariant(response.preferences.version === parsed.expectedPreferencesVersion + 1 && equal(response.preferences.preferences, parsed.preferences));return response;
}
export async function setNameRetention(auth: AuthenticatedContext, projectId: string, value: unknown) {
  id(projectId);const parsed = input(updateNameRetentionSchema, value);const verifier = new CandidateVerifier(auth);
  await verifier.candidate(projectId, parsed.candidateId);
  const response = await rpc(auth, "set_name_retention", { p_project_id: projectId, p_candidate_id: parsed.candidateId, p_expected_revision: parsed.expectedRevision, p_favorite: parsed.favorite, p_saved: parsed.saved }, updateNameRetentionResponseSchema);
  scope(auth, projectId, response.entry.candidate);invariant(response.entry.candidate.id === parsed.candidateId && response.entry.retention.revision === parsed.expectedRevision + 1 && response.entry.retention.favorite === parsed.favorite && response.entry.retention.saved === parsed.saved);
  await verifier.candidate(projectId, parsed.candidateId, response.entry.candidate);return response;
}
export async function saveNamingView(auth: AuthenticatedContext, projectId: string, value: unknown) {
  id(projectId);const parsed = input(updateNamingViewStateSchema, value);const verifier = new CandidateVerifier(auth);
  for (const candidateId of [parsed.viewState.scrollCandidateId, parsed.viewState.workshopCandidateId]) if (candidateId) await verifier.candidate(projectId, candidateId);
  const response = await rpc(auth, "save_naming_view", { p_project_id: projectId, p_expected_revision: parsed.expectedViewRevision, p_view: parsed.viewState }, updateNamingViewStateResponseSchema);
  // A legacy view body omits question metadata; SQL preserves the owned saved
  // checkpoint rather than allowing older clients to erase explicit answers.
  const expectedView = parsed.viewState.namingChat === undefined && response.session.viewState.namingChat
    ? { ...parsed.viewState, namingChat: response.session.viewState.namingChat } : parsed.viewState;
  scope(auth, projectId, response.session);invariant(response.session.viewRevision === parsed.expectedViewRevision + 1 && equal(response.session.viewState, expectedView));return response;
}
export async function selectProjectName(auth: AuthenticatedContext, projectId: string, value: unknown) {
  id(projectId);const parsed = input(selectProjectNameSchema, value);const verifier = new CandidateVerifier(auth);await verifier.candidate(projectId, parsed.candidateId);
  const response = await rpc(auth, "select_project_name", { p_project_id: projectId, p_candidate_id: parsed.candidateId, p_expected_revision: parsed.expectedRevision, p_accept_earlier_context: parsed.acceptEarlierContext }, selectProjectNameResponseSchema);
  scope(auth, projectId, response.session);invariant(response.project.current_revision === parsed.expectedRevision + 1 && response.currentSelection.candidate.id === parsed.candidateId && response.currentSelection.selection.acceptedEarlierContext === parsed.acceptEarlierContext);
  await verifier.candidate(projectId, parsed.candidateId, response.currentSelection.candidate);return response;
}
export async function importLocalName(auth: AuthenticatedContext, projectId: string, value: unknown) {
  id(projectId);const parsed = input(importProjectNameSchema, value);
  const response = await rpc(auth, "import_local_name", { p_project_id: projectId, p_expected_revision: parsed.expectedProjectRevision, p_source: parsed.source, p_context: parsed.capturedContext,
    p_identity_key: nameIdentityKey(parsed.source.value), p_idempotency_key: parsed.idempotencyKey }, importProjectNameResponseSchema);
  const candidate = response.entry.candidate;scope(auth, projectId, candidate);
  invariant(candidate.contextRevision === parsed.expectedProjectRevision && candidate.origin.kind === "local_import" && equal(candidate.origin.source, parsed.source) && equal(candidate.origin.capturedContext, parsed.capturedContext));
  await new CandidateVerifier(auth).candidate(projectId, candidate.id, candidate);return response;
}
export async function createBrandFromProjectName(auth: AuthenticatedContext, projectId: string, value: unknown) {
  id(projectId);const parsed = input(createBrandFromProjectNameSchema, value);if (parsed.sourceProjectId !== projectId) throw new ApiError("not_found");
  const verifier = new CandidateVerifier(auth);await verifier.candidate(projectId, parsed.sourceCandidateId);
  const response = await rpc(auth, "create_brand_from_project_name", { p_project_id: projectId, p_candidate_id: parsed.sourceCandidateId, p_expected_source_revision: parsed.expectedSourceProjectRevision,
    p_title: parsed.title, p_accept_earlier_context: parsed.acceptEarlierContext, p_idempotency_key: parsed.idempotencyKey }, createBrandFromProjectNameResponseSchema);
  const candidate = response.currentSelection.candidate;
  if (response.project.owner_id !== auth.userId || response.project.id === projectId) throw new ApiError("not_found");
  invariant(response.currentSelection.selection.acceptedEarlierContext === parsed.acceptEarlierContext && response.project.title === parsed.title && candidate.origin.kind === "account_copy" && candidate.origin.sourceProjectId === projectId && candidate.origin.sourceCandidateId === parsed.sourceCandidateId && candidate.origin.sourceContextRevision === parsed.expectedSourceProjectRevision);
  invariant(parsed.acceptEarlierContext || equal(candidate.strategyBasis, namingStrategyBasis(response.project.context)));
  await verifier.candidate(response.project.id, candidate.id, candidate);return response;
}
export async function getAccountNames(auth: AuthenticatedContext, value: unknown = {}) {
  const response = await rpc(auth, "get_account_names", { p_query: input(listAccountNamesSchema, value) }, accountNamesPageSchema);
  if (response.ownerId !== auth.userId) throw new ApiError("not_found");const verifier = new CandidateVerifier(auth);
  for (const row of response.items) await verifier.candidate(row.candidate.projectId, row.candidate.id, row.candidate);
  return response;
}

/** Route query parser: paired stable cursor and bounded typed filters only. */
export function readNamingQuery(request: Request, kind: "candidates" | "batches" | "library" = "candidates") {
  const params = new URL(request.url).searchParams;
  if (![...params].length) return undefined;
  const allowed = kind === "batches" ? ["cursorCreatedAt", "cursorId", "limit"] : ["cursorCreatedAt", "cursorId", "limit", "filter", "query", ...(kind === "candidates" ? ["batchId"] : [])];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new ApiError("invalid_input");
  if (params.has("cursorCreatedAt") !== params.has("cursorId")) throw new ApiError("invalid_input");
  const value = { ...(params.has("cursorId") ? { cursor: { createdAt: params.get("cursorCreatedAt"), id: params.get("cursorId") } } : {}),
    ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}), ...(params.has("filter") ? { filter: params.get("filter") } : {}),
    ...(params.has("query") ? { query: params.get("query") } : {}), ...(params.has("batchId") ? { batchId: params.get("batchId") } : {}) };
  return kind === "batches" ? input(listNamingBatchesSchema, value) : kind === "library" ? input(listAccountNamesSchema, value) : input(listProjectNamesSchema, value);
}

/** Read-only reuse for owned imports; replay every immutable parent before exposing text. */
export async function getVerifiedProjectName(auth: AuthenticatedContext, projectId: string, candidateId: string) {
  return new CandidateVerifier(auth).candidate(id(projectId), id(candidateId));
}
