import "server-only";
import { z } from "zod";
import { logoMutationReceiptSchema, type LogoMutationReceipt } from "@/domain/logo-workspace";
import { logoVariantSetSchema, type LogoVariantSet } from "@/domain/logo-deliverables";
import {
  logoTrustedCommandSchema,
  type LogoTrustedCommand,
} from "@/features/logo-vector/model/proposal-materialization";
import type { IdentityConnectionFactory, IdentityTransactionConnection } from "./identity-transaction";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

/** A lost response is not evidence that a manual transaction failed. The caller
 * retains this exact key/body, reads its receipt, then may explicitly replay it. */
export class LogoUncertainCommitError extends ApiError {
  readonly recovery: { projectId: string; input: LogoTrustedCommand };
  constructor(projectId: string, input: LogoTrustedCommand) {
    super("integration_unavailable");
    this.name = "LogoUncertainCommitError";
    this.recovery = { projectId, input: structuredClone(input) };
  }
}
export function logoDatabaseError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (["P0002", "PGRST116"].includes(code)) return new ApiError("not_found");
  if (["PT409", "23505", "40001"].includes(code)) return new ApiError("conflict");
  if (["22023", "23514", "23502", "22P02", "22007", "22008", "22003"].includes(code))
    return new ApiError("invalid_input");
  return new ApiError("integration_unavailable");
}
export function logoOwner(auth: Pick<AuthenticatedContext, "userId">): string {
  if (!z.uuid().safeParse(auth.userId).success) throw new ApiError("unauthenticated");
  return auth.userId.toLowerCase();
}
export function logoId(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new ApiError("not_found");
  return value.toLowerCase();
}
export function parseLogoInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("invalid_input");
  return parsed.data;
}
export function parseLogoStored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  return parsed.data;
}

/** Producers inspect immutable owned sources and bytes before locks. They are
 * server-injected capabilities; HTTP commands never carry their evidence. */
export type LogoMutationProducer = (
  auth: AuthenticatedContext,
  projectId: string,
  command: LogoTrustedCommand,
  signal?: AbortSignal,
) => Promise<unknown>;
export type LogoMutationProducers = Partial<Record<LogoTrustedCommand["method"], LogoMutationProducer>>;
const loginSchema = z.strictObject({ role_name: z.string(), role_oid: z.coerce.number().int().positive() });
const valueSchema = z.strictObject({ value: z.unknown() });
const active = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new ApiError("integration_unavailable");
};
export function createLogoTransactionService(
  factory: IdentityConnectionFactory | null,
  producers: LogoMutationProducers = {},
) {
  async function run(
    auth: AuthenticatedContext,
    projectId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<LogoMutationReceipt | LogoVariantSet> {
    const owner = logoOwner(auth);
    projectId = logoId(projectId);
    const command = parseLogoInput(logoTrustedCommandSchema, input);
    active(signal);
    if (!factory) throw new ApiError("integration_unavailable");
    async function acquire() {
      const acquired = await factory!.acquire(owner, signal);
      try {
        active(signal);
        if (acquired.binding.ownerId !== owner) throw new ApiError("not_found");
        const response = await acquired.connection.query(
          "SELECT session_user::text AS role_name, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid",
        );
        const login = parseLogoStored(loginSchema, response.rows[0]);
        if (login.role_name !== acquired.binding.roleName || login.role_oid !== acquired.binding.roleOid)
          throw new ApiError("integration_unavailable");
        return acquired.connection;
      } catch (error) {
        try {
          await acquired.connection.release(true);
        } catch {
          await acquired.connection.discard();
        }
        throw logoDatabaseError(error);
      }
    }
    function receipt(value: unknown): LogoMutationReceipt | LogoVariantSet {
      if (command.method === "prepareLogoVariants") {
        const set = parseLogoStored(logoVariantSetSchema, value);
        if (
          set.ownerId !== owner ||
          set.projectId !== projectId ||
          set.approvedLogoId !== command.body.approvedLogoId ||
          set.directionApprovalId !== command.body.directionApprovalId
        )
          throw new ApiError("integration_unavailable");
        return set;
      }
      const result = parseLogoStored(logoMutationReceiptSchema, value);
      if (
        result.ownerId !== owner ||
        result.projectId !== projectId ||
        result.requestKey !== command.body.requestKey ||
        result.workspace.heads.workspaceRevision !== command.body.expected.workspaceRevision + 1 ||
        result.revision.revision !== command.body.expected.stageRevisions[result.revision.stage] + 1
      )
        throw new ApiError("integration_unavailable");
      if (
        command.method === "applyLogoVectorProposal" &&
        (result.revision.stage !== "refinements" ||
          result.revision.payload.vectorRevisionId === null ||
          result.revision.payload.approvalId !== null ||
          result.revision.payload.sourceRequestKey !== command.body.requestKey)
      )
        throw new ApiError("integration_unavailable");
      return result;
    }
    // Recover BEFORE producer work. Fixed SQL compares the entire original body.
    const reader = await acquire();
    let replay: unknown,
      readerFailed = false;
    try {
      const response = await reader.query(
        "SELECT fluid_private.read_logo_trusted_request($1::uuid,$2::jsonb) AS value",
        [projectId, JSON.stringify(command)],
      );
      replay = parseLogoStored(valueSchema, response.rows[0]).value;
    } catch (error) {
      readerFailed = true;
      throw logoDatabaseError(error);
    } finally {
      try {
        await reader.release(readerFailed);
      } catch {
        await reader.discard();
        throw new ApiError("integration_unavailable");
      }
    }
    active(signal);
    if (replay !== null) return receipt(replay);
    const producer = producers[command.method];
    if (!producer) throw new ApiError("integration_unavailable");
    const evidence = await producer(auth, projectId, command, signal);
    active(signal);
    let serialized: string;
    try {
      serialized = JSON.stringify(evidence);
      if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 2_097_152)
        throw Error("Unbounded producer evidence");
    } catch {
      throw new ApiError("integration_unavailable");
    }
    let connection: IdentityTransactionConnection | undefined,
      began = false,
      commitStarted = false,
      committed = false,
      discard = false,
      result: LogoMutationReceipt | LogoVariantSet | undefined,
      failure: ApiError | undefined;
    try {
      connection = await acquire();
      active(signal);
      began = true;
      await connection.query("BEGIN");
      await connection.query("SET LOCAL statement_timeout = '5000ms'");
      await connection.query("SET LOCAL lock_timeout = '1500ms'");
      await connection.query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
      const response = await connection.query(
        "SELECT fluid_private.apply_logo_trusted_command($1::uuid,$2::jsonb,$3::jsonb) AS value",
        [projectId, JSON.stringify(command), serialized],
      );
      result = receipt(parseLogoStored(valueSchema, response.rows[0]).value);
      active(signal);
      commitStarted = true;
      await connection.query("COMMIT");
      committed = true;
      active(signal);
    } catch (error) {
      discard = commitStarted;
      failure = commitStarted ? new LogoUncertainCommitError(projectId, command) : logoDatabaseError(error);
      if (connection && began && !committed) {
        try {
          await connection.query("ROLLBACK");
        } catch {
          discard = true;
        }
      }
    } finally {
      if (connection) {
        try {
          await connection.release(discard);
        } catch {
          try {
            await connection.discard();
          } catch {}
          failure = commitStarted
            ? new LogoUncertainCommitError(projectId, command)
            : new ApiError("integration_unavailable");
        }
      }
    }
    if (failure) throw failure;
    if (signal?.aborted) throw new LogoUncertainCommitError(projectId, command);
    if (!result) throw new ApiError("integration_unavailable");
    return result;
  }
  return { run };
}
export const productionLogoTransactions = createLogoTransactionService(null);
