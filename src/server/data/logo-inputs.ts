import "server-only";
import { z } from "zod";
import { fontRecordSchema, type FontRecord } from "@/domain/logo-directions";
import {
  logoPageQuerySchema,
  logoReferencePageSchema,
  logoWorkspaceV2Schema,
  type LogoReferenceRegistration,
  type LogoReferencePage,
} from "@/domain/logo-workspace";
import {
  catalogLogoFontSchema,
  importCatalogLogoFontInputSchema,
  logoInputRequestStateSchema,
  logoInputCancellationSchema,
  logoInputRequestPageSchema,
  logoInputRequestQuerySchema,
  referenceUploadInputSchema,
  uploadLogoFontInputSchema,
  LOGO_INPUT_METADATA_MAX_BYTES,
  type CatalogLogoFont,
  type LogoInputRequest,
  type LogoInputRequestState,
  type LogoInputRequestPage,
} from "@/features/logo-inputs/model/contracts";
import {
  createLogoInputRegistration,
  inputHash,
  activeLogoInput,
  LogoInputUncertainCommitError,
  type LogoInputRegistry,
} from "@/features/logo-inputs/server/registration";
import { canonicalIdentityInput } from "@/features/identity-directions/model/font-check-binding";
import { listFreeFontCatalog, readFreeCatalogFont } from "@/features/identity-directions/server/fonts";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import type { IdentityAssetStore } from "./identity-asset-store";
import type { IdentityConnectionFactory } from "./identity-transaction";
import { logoOwner, logoId, logoDatabaseError, parseLogoInput, parseLogoStored } from "./logo-transaction";
export { LogoInputUncertainCommitError, validateLogoInputBytes } from "@/features/logo-inputs/server/registration";

const principalSchema = z.strictObject({ role_name: z.string(), role_oid: z.coerce.number().int().positive() });
const valueSchema = z.strictObject({ value: z.unknown() });
async function read(
  auth: AuthenticatedContext,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  logoOwner(auth);
  activeLogoInput(signal);
  const pending = auth.client.rpc(name, args),
    response = await (signal ? pending.abortSignal(signal) : pending);
  activeLogoInput(signal);
  if (response.error) throw logoDatabaseError(response.error);
  return response.data;
}
function scopedState(
  auth: AuthenticatedContext,
  projectId: string,
  key: string,
  value: unknown,
): LogoInputRequestState {
  const state = parseLogoStored(logoInputRequestStateSchema, value);
  if (
    state.status !== "not_found" &&
    (state.ownerId !== logoOwner(auth) || state.projectId !== projectId || state.requestKey !== key)
  )
    throw new ApiError("not_found");
  return state;
}
function parseMetadata<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = parseLogoInput(schema, value);
  if (Buffer.byteLength(JSON.stringify(parsed)) > LOGO_INPUT_METADATA_MAX_BYTES) throw new ApiError("invalid_input");
  return parsed;
}
/** Only two fixed write functions use this explicitly injected, owner-bound login.
 * Public reads use the actual authenticated account. No privileged fallback. */
function createPostgresLogoInputRegistry(factory: IdentityConnectionFactory): LogoInputRegistry {
  async function write(
    auth: AuthenticatedContext,
    projectId: string,
    request: LogoInputRequest,
    sql: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<LogoInputRequestState> {
    const ownerId = logoOwner(auth);
    activeLogoInput(signal);
    let acquired: Awaited<ReturnType<IdentityConnectionFactory["acquire"]>>;
    try {
      acquired = await factory.acquire(ownerId, signal);
    } catch (error) {
      throw logoDatabaseError(error);
    }
    let attempted = false,
      failed = false,
      result: LogoInputRequestState | undefined,
      failure: ApiError | undefined;
    try {
      activeLogoInput(signal);
      if (acquired.binding.ownerId !== ownerId) throw new ApiError("not_found");
      const principal = await acquired.connection.query(
        "SELECT session_user::text AS role_name, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid",
      );
      const identity = parseLogoStored(principalSchema, principal.rows[0]);
      if (identity.role_name !== acquired.binding.roleName || identity.role_oid !== acquired.binding.roleOid)
        throw new ApiError("integration_unavailable");
      activeLogoInput(signal);
      attempted = true;
      const response = await acquired.connection.query(sql, args);
      activeLogoInput(signal);
      result = scopedState(
        auth,
        projectId,
        request.input.requestKey,
        parseLogoStored(valueSchema, response.rows[0]).value,
      );
    } catch (error) {
      failed = true;
      const mapped = logoDatabaseError(error);
      failure =
        attempted && mapped.code === "integration_unavailable"
          ? new LogoInputUncertainCommitError(projectId, request.input.requestKey)
          : mapped;
    } finally {
      try {
        await acquired.connection.release(failed);
      } catch {
        try {
          await acquired.connection.discard();
        } catch {}
        failure = attempted
          ? new LogoInputUncertainCommitError(projectId, request.input.requestKey)
          : new ApiError("integration_unavailable");
      }
    }
    if (failure) throw failure;
    if (!result || signal?.aborted) throw new LogoInputUncertainCommitError(projectId, request.input.requestKey);
    return result;
  }
  return {
    prepare: (auth, projectId, request, signal) =>
      write(
        auth,
        projectId,
        request,
        "SELECT fluid_private.prepare_logo_input($1::uuid,$2::jsonb) AS value",
        [projectId, JSON.stringify(request)],
        signal,
      ),
    commit: (auth, projectId, request, receipt, evidence, signal) =>
      write(
        auth,
        projectId,
        request,
        "SELECT fluid_private.commit_logo_input($1::uuid,$2::jsonb,$3::jsonb,$4::jsonb) AS value",
        [projectId, JSON.stringify(request), JSON.stringify(receipt), JSON.stringify(evidence)],
        signal,
      ),
  };
}
export function createLogoInputService(
  dependencies: { assets: IdentityAssetStore; connections: IdentityConnectionFactory } | null,
) {
  const register = createLogoInputRegistration(
    dependencies
      ? { assets: dependencies.assets, registry: createPostgresLogoInputRegistry(dependencies.connections) }
      : null,
  );
  function file(bytes: Uint8Array, mimeType: string) {
    if (!(bytes instanceof Uint8Array)) throw new ApiError("invalid_input");
    return { contentHash: inputHash(bytes), byteLength: bytes.byteLength, mimeType };
  }
  async function ownedWorkspace(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal) {
    const workspace = parseLogoStored(
      logoWorkspaceV2Schema,
      await read(auth, "get_logo_workspace", { p_project_id: projectId }, signal),
    );
    if (workspace.ownerId !== logoOwner(auth) || workspace.projectId !== projectId) throw new ApiError("not_found");
    return workspace;
  }
  return {
    configured: dependencies !== null,
    async uploadLogoReference(
      auth: AuthenticatedContext,
      projectId: string,
      metadata: unknown,
      bytes: Uint8Array,
      mimeType: string,
      signal?: AbortSignal,
    ): Promise<LogoReferenceRegistration> {
      const input = parseMetadata(referenceUploadInputSchema, metadata);
      return (await register(
        auth,
        projectId,
        { kind: "reference_upload", input, file: file(bytes, mimeType) } as LogoInputRequest,
        bytes,
        signal,
      )) as LogoReferenceRegistration;
    },
    async uploadLogoFont(
      auth: AuthenticatedContext,
      projectId: string,
      metadata: unknown,
      bytes: Uint8Array,
      mimeType: string,
      signal?: AbortSignal,
    ): Promise<FontRecord> {
      const input = parseMetadata(uploadLogoFontInputSchema, metadata);
      return (await register(
        auth,
        projectId,
        { kind: "font_upload", input, file: file(bytes, mimeType) } as LogoInputRequest,
        bytes,
        signal,
      )) as FontRecord;
    },
    async importCatalogLogoFont(
      auth: AuthenticatedContext,
      projectId: string,
      metadata: unknown,
      signal?: AbortSignal,
    ): Promise<FontRecord> {
      logoOwner(auth);
      projectId = logoId(projectId);
      activeLogoInput(signal);
      const input = parseMetadata(importCatalogLogoFontInputSchema, metadata);
      if (!dependencies) throw new ApiError("integration_unavailable");
      const source = await readFreeCatalogFont(input.catalogFontId);
      return (await register(
        auth,
        projectId,
        { kind: "font_catalog", input, file: file(source.bytes, source.mimeType) } as LogoInputRequest,
        source.bytes,
        signal,
      )) as FontRecord;
    },
    async cancelLogoInputRequest(
      auth: AuthenticatedContext,
      projectId: string,
      raw: unknown,
      signal?: AbortSignal,
    ): Promise<LogoInputRequestState> {
      logoOwner(auth);
      projectId = logoId(projectId);
      const request = parseLogoInput(logoInputCancellationSchema, raw);
      activeLogoInput(signal);
      try {
        const state = scopedState(
          auth,
          projectId,
          request.input.requestKey,
          await read(auth, "cancel_logo_input_request", { p_project_id: projectId, p_request: request }, signal),
        );
        if (
          (state.status !== "rejected" && state.status !== "succeeded") ||
          canonicalIdentityInput(state.request) !== canonicalIdentityInput(request)
        )
          throw new ApiError("integration_unavailable");
        return state;
      } catch (error) {
        const mapped = logoDatabaseError(error);
        if (mapped.code === "integration_unavailable")
          throw new LogoInputUncertainCommitError(projectId, request.input.requestKey);
        throw mapped;
      }
    },
    async readLogoInputRequest(
      auth: AuthenticatedContext,
      projectId: string,
      requestKey: string,
      signal?: AbortSignal,
    ): Promise<LogoInputRequestState> {
      projectId = logoId(projectId);
      requestKey = logoId(requestKey);
      return scopedState(
        auth,
        projectId,
        requestKey,
        await read(auth, "read_logo_input_request", { p_project_id: projectId, p_request_key: requestKey }, signal),
      );
    },
    async listLogoInputRequests(
      auth: AuthenticatedContext,
      projectId: string,
      query: unknown = {},
      signal?: AbortSignal,
    ): Promise<LogoInputRequestPage> {
      projectId = logoId(projectId);
      const input = parseLogoInput(logoInputRequestQuerySchema, query);
      const page = parseLogoStored(
        logoInputRequestPageSchema,
        await read(auth, "list_logo_input_requests", { p_project_id: projectId, p_query: input }, signal),
      );
      if (page.ownerId !== logoOwner(auth) || page.projectId !== projectId) throw new ApiError("not_found");
      return page;
    },
    async listLogoReferences(
      auth: AuthenticatedContext,
      projectId: string,
      query: unknown = {},
      signal?: AbortSignal,
    ): Promise<LogoReferencePage> {
      projectId = logoId(projectId);
      const input = parseLogoInput(logoPageQuerySchema, query);
      if (input.cursor) logoId(input.cursor);
      const page = parseLogoStored(
        logoReferencePageSchema,
        await read(auth, "list_logo_input_references", { p_project_id: projectId, p_query: input }, signal),
      );
      if (page.ownerId !== logoOwner(auth) || page.projectId !== projectId) throw new ApiError("not_found");
      return page;
    },
    async listLogoFonts(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<FontRecord[]> {
      projectId = logoId(projectId);
      const fonts = parseLogoStored(
        z.array(fontRecordSchema).max(100),
        await read(auth, "list_logo_input_fonts", { p_project_id: projectId }, signal),
      );
      if (
        fonts.some((font) => font.asset.ownerId !== logoOwner(auth) || font.asset.projectId !== projectId) ||
        new Set(fonts.map((font) => font.id)).size !== fonts.length
      )
        throw new ApiError("not_found");
      return fonts;
    },
    async listCatalogLogoFonts(
      auth: AuthenticatedContext,
      projectId: string,
      signal?: AbortSignal,
    ): Promise<CatalogLogoFont[]> {
      projectId = logoId(projectId);
      await ownedWorkspace(auth, projectId, signal);
      const catalog = await listFreeFontCatalog();
      activeLogoInput(signal);
      const verified = await Promise.all(
        catalog.map(async (entry) => {
          const source = await readFreeCatalogFont(entry.id);
          return { ...entry, mimeType: source.mimeType, byteLength: source.bytes.byteLength };
        }),
      );
      activeLogoInput(signal);
      return parseLogoStored(z.array(catalogLogoFontSchema).max(100), verified);
    },
  };
}
export const productionLogoInputService = createLogoInputService(null);
