import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiError, logServerError } from "../http/errors";
import { runAccountDeletion, supabaseDeletionStore, type AccountDeletionStore } from "./deletion";

const REMOVE_BATCH = 100;
const ORPHAN_PAGES = 20;

/** The cleanup job is called with "Authorization: Bearer <CRON_SECRET>", the
 * header Vercel Cron sends, so a cron entry can be added later without changes. */
export function assertMaintenanceCaller(request: Request, secret = process.env.CRON_SECRET) {
  if (!secret || secret.length < 16) throw new ApiError("integration_unavailable");
  const given = request.headers.get("authorization") ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) throw new ApiError("unauthenticated");
}

export interface OrphanStore {
  listOrphans(after: string | null): Promise<string[]>;
  removeFiles(paths: string[]): Promise<number>;
}

/** Removes Storage objects whose account or project no longer exists (see
 * public.orphaned_storage_objects). Objects of soft-deleted projects are kept. */
export async function purgeOrphanedFiles(store: OrphanStore) {
  let removed = 0, after: string | null = null;
  for (let page = 0; page < ORPHAN_PAGES; page++) {
    const names = await store.listOrphans(after);
    if (!names.length) break;
    for (let index = 0; index < names.length; index += REMOVE_BATCH) removed += await store.removeFiles(names.slice(index, index + REMOVE_BATCH));
    after = names.at(-1)!;
  }
  return removed;
}

/** Finishes deletions that stopped part-way (the person closed the page, a
 * service was briefly unavailable). The person already confirmed them. */
export async function resumePendingDeletions(listPending: () => Promise<string[]>, store: AccountDeletionStore) {
  let finished = 0, failed = 0;
  for (const ownerId of await listPending()) {
    try { await runAccountDeletion(ownerId, store); finished += 1; }
    catch (error) { failed += 1; logServerError("account_deletion_resume_failed", error); }
  }
  return { finished, failed };
}

export async function runAccountCleanup(admin: SupabaseClient) {
  const deletions = await resumePendingDeletions(async () => {
    const { data, error } = await admin.rpc("account_deletions_pending", { p_min_age: "15 minutes", p_limit: 20 });
    if (error) throw Object.assign(new Error("account_deletions_pending"), { code: error.code });
    return z.array(z.object({ owner_id: z.uuid() })).parse(data ?? []).map(row => row.owner_id);
  }, supabaseDeletionStore(admin));
  const orphanedFilesRemoved = await purgeOrphanedFiles({
    async listOrphans(after) {
      const { data, error } = await admin.rpc("orphaned_storage_objects", { p_after: after, p_limit: 500 });
      if (error) throw Object.assign(new Error("orphaned_storage_objects"), { code: error.code });
      return z.array(z.string()).parse(data ?? []);
    },
    async removeFiles(paths) {
      const { data, error } = await admin.storage.from("fluid-assets").remove(paths);
      if (error) throw new Error("orphaned_storage_remove");
      return data?.length ?? 0;
    },
  });
  return { resumedDeletions: deletions.finished, failedDeletions: deletions.failed, orphanedFilesRemoved };
}
