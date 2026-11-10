import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { z } from "zod";
import { getVerifiedAccountContext } from "../auth/context";
import { ApiError, logServerError } from "../http/errors";
import { accountAdminClient } from "./admin";

/** Deleting an account needs a sign-in from the last 15 minutes. */
export const FRESH_SIGN_IN_SECONDS = 15 * 60;
const BUCKET = "fluid-assets";
/** Storage API batch size, and the most pages one deletion walks (500 × 400 files). */
const REMOVE_BATCH = 100;
const LIST_PAGE = 500;
const MAX_FILE_PAGES = 400;

export const accountDeletionInputSchema = z.strictObject({ confirmEmail: z.string().trim().min(3).max(320) });

const amrSchema = z.array(z.union([z.string(), z.object({ method: z.string(), timestamp: z.number() })]));

/** The newest sign-in time recorded in the session's access token ("amr"), in seconds. */
export function sessionSignedInAt(claims: unknown): number | null {
  if (!claims || typeof claims !== "object") return null;
  const amr = amrSchema.safeParse((claims as { amr?: unknown }).amr);
  if (!amr.success) return null;
  const times = amr.data.flatMap(entry => typeof entry === "object" && Number.isFinite(entry.timestamp) ? [entry.timestamp] : []);
  return times.length ? Math.max(...times) : null;
}

export function assertFreshSignIn(claims: unknown, nowSeconds = Date.now() / 1000) {
  const signedInAt = sessionSignedInAt(claims);
  if (signedInAt === null || signedInAt > nowSeconds + 60 || nowSeconds - signedInAt > FRESH_SIGN_IN_SECONDS) {
    throw new ApiError("reauthentication_required");
  }
}

/** Typed-email confirmation: case-insensitive, surrounding spaces ignored. */
export function assertConfirmationEmail(user: Pick<User, "email">, typed: string) {
  const email = user.email?.trim().toLowerCase();
  if (!email || typed.trim().toLowerCase() !== email) throw new ApiError("confirmation_mismatch");
}

/** The verified person, with the sign-in time of this session checked against the Auth server. */
export async function getDeletionContext(signal?: AbortSignal) {
  const { client, user } = await getVerifiedAccountContext(signal);
  const { data, error } = await client.auth.getClaims().catch(() => ({ data: null, error: new Error("claims") }));
  if (error || !data?.claims || data.claims.sub !== user.id) throw new ApiError("unauthenticated");
  return { client, user, claims: data.claims as unknown };
}
export type DeletionContext = Awaited<ReturnType<typeof getDeletionContext>>;

/** The server-side steps of one deletion. Every step can be repeated safely. */
export interface AccountDeletionStore {
  begin(ownerId: string): Promise<void>;
  purge(ownerId: string): Promise<number>;
  listFiles(ownerId: string): Promise<string[]>;
  removeFiles(paths: string[]): Promise<number>;
  recordFilesRemoved(ownerId: string, count: number): Promise<void>;
  /** Resolves when the Auth user is gone, including when it already was. */
  deleteAuthUser(ownerId: string): Promise<void>;
  complete(ownerId: string): Promise<void>;
}

/**
 * Deletes one account: rows first (one database transaction, which also keeps
 * the anonymised accounting records), then every Storage object under the
 * account's prefix, then the Auth user, then the receipt is closed. A failure
 * at any point leaves a pending receipt, and running this again (by the person,
 * or by the cleanup job) continues from wherever the last attempt stopped.
 */
export async function runAccountDeletion(ownerId: string, store: AccountDeletionStore) {
  if (!z.uuid().safeParse(ownerId).success) throw new ApiError("invalid_input");
  await store.begin(ownerId);
  const deletedRows = await store.purge(ownerId);
  const deletedFiles = await removeAccountFiles(ownerId, store);
  await store.deleteAuthUser(ownerId);
  await store.complete(ownerId);
  return { deletedRows, deletedFiles };
}

async function removeAccountFiles(ownerId: string, store: AccountDeletionStore) {
  const prefix = `${ownerId.toLowerCase()}/`;
  let removed = 0;
  for (let page = 0; page < MAX_FILE_PAGES; page++) {
    // Always the first page: removed objects disappear from the listing, so an
    // interrupted run resumes with whatever is still there.
    const names = await store.listFiles(ownerId);
    if (!names.length) return removed;
    if (names.some(name => !name.startsWith(prefix))) throw new Error("account_file_outside_prefix");
    let removedThisPage = 0;
    for (let index = 0; index < names.length; index += REMOVE_BATCH) {
      removedThisPage += await store.removeFiles(names.slice(index, index + REMOVE_BATCH));
    }
    // Storage reporting nothing removed for listed files would loop forever.
    if (removedThisPage === 0) throw new Error("account_files_not_removed");
    await store.recordFilesRemoved(ownerId, removedThisPage);
    removed += removedThisPage;
  }
  throw new Error("account_files_too_many");
}

function rpcFailure(step: string, error: { code?: string; message?: string } | null) {
  if (!error) return;
  throw Object.assign(new Error(`account_deletion_${step}`), { code: typeof error.code === "string" ? error.code : undefined });
}

/** The store backed by Supabase with the server's secret key. */
export function supabaseDeletionStore(admin: SupabaseClient): AccountDeletionStore {
  return {
    async begin(ownerId) {
      const { error } = await admin.rpc("account_deletion_begin", { p_owner: ownerId });
      // A resumed deletion whose Auth user is already gone has no row to start from.
      if (error && error.code !== "P0002") rpcFailure("begin", error);
    },
    async purge(ownerId) {
      const { data, error } = await admin.rpc("account_deletion_purge", { p_owner: ownerId });
      rpcFailure("purge", error);
      const parsed = z.object({ deletedRows: z.number().int().nonnegative() }).safeParse(data);
      if (!parsed.success) throw new Error("account_deletion_purge_result");
      return parsed.data.deletedRows;
    },
    async listFiles(ownerId) {
      const { data, error } = await admin.rpc("account_storage_objects", { p_owner: ownerId, p_after: null, p_limit: LIST_PAGE });
      rpcFailure("list_files", error);
      return z.array(z.string()).parse(data ?? []);
    },
    async removeFiles(paths) {
      const { data, error } = await admin.storage.from(BUCKET).remove(paths);
      if (error) throw Object.assign(new Error("account_deletion_remove_files"), { code: "storage" });
      return data?.length ?? 0;
    },
    async recordFilesRemoved(ownerId, count) {
      const { error } = await admin.rpc("account_deletion_files_removed", { p_owner: ownerId, p_count: count });
      rpcFailure("record_files", error);
    },
    async deleteAuthUser(ownerId) {
      const { error } = await admin.auth.admin.deleteUser(ownerId, false);
      if (error && error.status !== 404) throw Object.assign(new Error("account_deletion_auth_user"), { code: error.code ?? String(error.status ?? "") });
    },
    async complete(ownerId) {
      const { error } = await admin.rpc("account_deletion_complete", { p_owner: ownerId });
      rpcFailure("complete", error);
    },
  };
}

/** Asks running and queued generations to stop, with the person's own login
 * (cancel_generation). Best effort: the purge removes their records either way. */
export async function cancelActiveGenerations(client: SupabaseClient, ownerId: string) {
  const { data, error } = await client.from("generation_runs").select("id").eq("owner_id", ownerId).in("status", ["queued", "running"]).limit(200);
  if (error) { logServerError("account_deletion_cancel_list", error); return 0; }
  let cancelled = 0;
  for (const run of z.array(z.object({ id: z.uuid() })).catch([]).parse(data ?? [])) {
    const result = await client.rpc("cancel_generation", { p_run_id: run.id });
    if (result.error) logServerError("account_deletion_cancel_run", result.error);
    else cancelled += 1;
  }
  return cancelled;
}

/** The whole request: confirmation, freshness, stopping work, deleting, signing out. */
export async function deleteSignedInAccount(context: DeletionContext, confirmEmail: string, admin: SupabaseClient = accountAdminClient()) {
  assertConfirmationEmail(context.user, confirmEmail);
  assertFreshSignIn(context.claims);
  await cancelActiveGenerations(context.client, context.user.id);
  try {
    await runAccountDeletion(context.user.id, supabaseDeletionStore(admin));
  } catch (error) {
    logServerError("account_deletion_incomplete", error);
    throw new ApiError("deletion_incomplete");
  }
  // The Auth user and its sessions are gone; clear this browser's cookies too.
  await context.client.auth.signOut({ scope: "local" }).catch(() => undefined);
}
