import "server-only";
import { z } from "zod";
import { STANDALONE_MUTATION_MAX_BYTES, saveStandaloneWorkspaceInputSchema, standaloneImportKey, standaloneImportResponseSchema,
  standaloneToolSchema, standaloneWorkspaceResponseSchema, type StandaloneImportSource, type StandaloneTool } from "@/domain/standalone-workspaces";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { standaloneCodec } from "./standalone-workspace-codecs";
import { getVerifiedProjectName } from "./project-naming";

type DiagnosticStage = "workspace_read_rpc" | "workspace_read_response" | "workspace_read_binding" | "workspace_source"
  | "import_read_rpc" | "import_read_response" | "import_read_binding" | "import_source"
  | "save_rpc" | "save_response" | "save_binding" | "save_source";

function localDiagnostic(stage: DiagnosticStage, details: {
  codeType?: string; code?: string; status?: number | null; issueCodes?: string[];
} = {}): void {
  if (process.env.FLUID_RUNTIME === "local" && !process.env.VERCEL) {
    // Only bounded classifications: never messages, payloads, IDs, paths, headers or credentials.
    try { console.warn("[fluid:standalone]", { stage, ...details }); }
    catch { /* Diagnostic delivery must never change the original save outcome. */ }
  }
}
function ownDiagnosticValue(value: unknown, key: "code" | "status"): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function rpcDiagnostic(stage: DiagnosticStage, code: unknown, status?: unknown): void {
  localDiagnostic(stage, {
    codeType: code === null ? "null" : typeof code,
    code: typeof code === "string" && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(code) ? code : "unrecognized",
    status: typeof status === "number" && Number.isInteger(status) && (status === 0 || (status >= 100 && status <= 599)) ? status : null,
  });
}
function parse<T>(schema: z.ZodType<T>, raw: unknown, storedStage?: DiagnosticStage): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    if (storedStage) localDiagnostic(storedStage, { issueCodes: [...new Set(result.error.issues.map(issue => issue.code))].slice(0, 8) });
    throw new ApiError(storedStage ? "integration_unavailable" : "invalid_input");
  }
  return result.data;
}
function toolValue(value: string): StandaloneTool {
  const result = standaloneToolSchema.safeParse(value);
  if (!result.success) throw new ApiError("not_found"); return result.data;
}
async function rpc(auth: AuthenticatedContext, name: "get_standalone_workspace" | "get_standalone_import" | "save_standalone_workspace", args: Record<string, unknown>) {
  const stage = { get_standalone_workspace: "workspace_read_rpc", get_standalone_import: "import_read_rpc", save_standalone_workspace: "save_rpc" } as const;
  const result = await Promise.resolve(auth.client.rpc(name, args)).catch(error => {
    rpcDiagnostic(stage[name], ownDiagnosticValue(error, "code"));
    throw new ApiError("integration_unavailable");
  });
  if (result.error) {
    const code = ownDiagnosticValue(result.error, "code");
    if (code === "P0002") throw new ApiError("not_found");
    if (typeof code === "string" && ["40001", "PT409", "23505"].includes(code)) throw new ApiError("conflict");
    if (typeof code === "string" && ["22023", "22P02", "22003", "23514", "23502"].includes(code)) throw new ApiError("invalid_input");
    if (code === "42501") throw new ApiError("unauthenticated");
    // Missing table/function, cache mismatch and transport failures are unavailable, never successful local fallback.
    rpcDiagnostic(stage[name], code, ownDiagnosticValue(result, "status"));
    throw new ApiError("integration_unavailable");
  }
  return result.data;
}
async function verifySource(auth: AuthenticatedContext, source: StandaloneImportSource, stage: "workspace_source" | "import_source" | "save_source") {
  if (source.candidateId) {
    try {
      const candidate = await getVerifiedProjectName(auth, source.projectId, source.candidateId);
      if (candidate.ownerId.toLowerCase() !== auth.userId.toLowerCase() || candidate.projectId.toLowerCase() !== source.projectId ||
          candidate.id.toLowerCase() !== source.candidateId || candidate.value !== source.name || candidate.contextRevision > source.projectRevision) throw new ApiError("integration_unavailable");
    } catch { localDiagnostic(stage); throw new ApiError("integration_unavailable"); }
  }
}
export async function getStandaloneWorkspace(auth: AuthenticatedContext, value: string) {
  const tool = toolValue(value);
  const response = parse(standaloneWorkspaceResponseSchema(standaloneCodec(tool)), await rpc(auth, "get_standalone_workspace", { p_tool: tool }), "workspace_read_response");
  if (response.ownerId !== auth.userId.toLowerCase()) { localDiagnostic("workspace_read_binding"); throw new ApiError("integration_unavailable"); }
  for (const source of response.workspace?.imports ?? []) await verifySource(auth, source, "workspace_source");
  return response;
}
export async function getStandaloneImport(auth: AuthenticatedContext, projectId: string) {
  if (!z.uuid().safeParse(projectId).success) throw new ApiError("not_found");
  const response = parse(standaloneImportResponseSchema.extend({ projectId: z.uuid() }), await rpc(auth, "get_standalone_import", { p_project_id: projectId.toLowerCase() }), "import_read_response");
  if (response.ownerId !== auth.userId.toLowerCase() || response.projectId.toLowerCase() !== projectId.toLowerCase() ||
      (response.source && response.source.projectId !== projectId.toLowerCase())) { localDiagnostic("import_read_binding"); throw new ApiError("integration_unavailable"); }
  if (response.source) await verifySource(auth, response.source, "import_source");
  return { ownerId: response.ownerId, source: response.source };
}
export async function saveStandaloneWorkspace(auth: AuthenticatedContext, value: string, raw: unknown) {
  const tool = toolValue(value), codec = standaloneCodec(tool);
  const input = parse(saveStandaloneWorkspaceInputSchema, raw);
  const payload = parse(codec.schema, input.payload);
  if (Buffer.byteLength(JSON.stringify({ ...input, payload }), "utf8") > STANDALONE_MUTATION_MAX_BYTES) throw new ApiError("body_too_large");
  const previous = await getStandaloneWorkspace(auth, tool);
  for (const choice of input.imports) {
    // Existing immutable imports remain frozen across later project edits. New imports must still be current.
    if (previous.workspace?.imports.some(source => standaloneImportKey(source) === standaloneImportKey(choice))) continue;
    const { source } = await getStandaloneImport(auth, choice.projectId);
    if (!source || standaloneImportKey(source) !== standaloneImportKey(choice)) throw new ApiError("conflict");
  }
  const response = parse(standaloneWorkspaceResponseSchema(codec), await rpc(auth, "save_standalone_workspace", {
    p_tool: tool, p_expected_revision: input.expectedRevision, p_request_key: input.requestKey, p_payload: payload, p_imports: input.imports,
  }), "save_response");
  const workspace = response.workspace;
  if (response.ownerId !== auth.userId.toLowerCase() || !workspace || workspace.revision !== input.expectedRevision + 1 ||
      (previous.workspace && workspace.id !== previous.workspace.id) || JSON.stringify(workspace.payload) !== JSON.stringify(payload) ||
      JSON.stringify(workspace.imports.map(({ projectId, projectRevision, selectionId }) => ({ projectId, projectRevision, selectionId }))) !== JSON.stringify(input.imports)) { localDiagnostic("save_binding"); throw new ApiError("integration_unavailable"); }
  for (const source of workspace.imports) await verifySource(auth, source, "save_source");
  return response;
}
