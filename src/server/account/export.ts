import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { z } from "zod";
import { getProfileContext, readAccountProfile, type ProfileContext } from "../data/account-profile";
import { ApiError, logServerError } from "../http/errors";
import { accountAdminClient } from "./admin";

/**
 * "Download my data": one ZIP, streamed while it is built, with
 *   README.txt         what the files are
 *   account.json       the account and profile
 *   data/<table>.json  every row the person owns in each app table, read with
 *                      their own login (row security decides what is included)
 *   files/…            the generated and uploaded files under their Storage prefix
 *   files.json         every file, and for any not included, why
 *
 * Why a streamed ZIP and not JSON plus signed links: links to private files
 * expire within a minute, so a list of them is useless by the time someone
 * opens it, while a ZIP holds the files themselves. Streaming keeps memory to
 * one file at a time (at most 50 MB, the bucket limit) instead of the whole
 * archive. File bytes are capped (FILE_BYTES_CAP) so one request stays within
 * the function's time limit; files beyond the cap are listed in files.json and
 * stay downloadable inside Embel.
 */
export const FILE_BYTES_CAP = 400 * 1024 * 1024;
const ROW_PAGE = 500;
const MAX_ROWS_PER_TABLE = 50_000;
const FILE_PAGE = 500;
const MAX_FILES = 5_000;

/** Internal bookkeeping that is not the person's data: provider costs, worker
 * leases, workflow and idempotency identifiers, internal plans. */
const INTERNAL_FIELD = /(^|_)cost(_|$)|microusd|^lease_|_lease$|workflow_run_id|idempotency_key|provider_response_id|^plan_(manifest|fingerprint)$|^worker_id$|^policy_identity$/u;

export type ExportTable = { table: string; keyColumns: string[] };
export interface AccountExportSource {
  tables(): Promise<ExportTable[]>;
  rows(table: ExportTable, offset: number, limit: number): Promise<Record<string, unknown>[]>;
  listFiles(after: string | null): Promise<string[]>;
  downloadFile(path: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export function exportRow(table: string, row: Record<string, unknown>): Record<string, unknown> | null {
  // "sent.*" outputs mark a paid call before it is sent; internal, like publicRun hides them.
  if (table === "generation_outputs" && typeof row.output_key === "string" && row.output_key.startsWith("sent.")) return null;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !INTERNAL_FIELD.test(key)));
}

const extensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif",
  "application/pdf": "pdf", "application/zip": "zip", "application/json": "json", "text/plain": "txt",
  "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf",
};
/** ZIP path for one Storage object: the path after the owner prefix, plus an extension. */
export function exportFileName(ownerId: string, path: string, mimeType: string) {
  const relative = path.slice(ownerId.length + 1).split("/").filter(part => part && part !== "." && part !== "..").join("/");
  const extension = extensions[mimeType.split(";", 1)[0]!.trim().toLowerCase()];
  return `files/${relative}${extension ? `.${extension}` : ""}`;
}

const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value, null, 2));

const README = `Your Embel data

account.json      Your account and profile settings.
data/*.json       Everything Embel stores for you, one file per kind of record:
                  projects and their saved versions, Strategy, Voice and Identity
                  work, generated names, logos and directions, and your requests.
files/            Logos, images and files you generated or uploaded.
files.json        Every file, and for any file not in this download, why.

Internal costs and processing details are left out.
`;

/** A ReadableStream that only builds the next part when the reader has room. */
function pacedStream(build: (write: (chunk: Uint8Array) => void, room: () => Promise<void>) => Promise<void>) {
  let wake: (() => void) | null = null;
  let cancelled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    pull() { wake?.(); wake = null; },
    // The person closed the page: stop reading files at the next step.
    cancel() { cancelled = true; wake?.(); wake = null; },
  }, { highWaterMark: 4 });
  const stopped = new Error("account_export_cancelled");
  const room = () => cancelled ? Promise.reject(stopped)
    : (controller.desiredSize ?? 1) > 0 ? Promise.resolve()
    : new Promise<void>((resolve, reject) => { wake = () => cancelled ? reject(stopped) : resolve(); });
  void build(chunk => { if (!cancelled) controller.enqueue(chunk); }, room).then(() => { if (!cancelled) controller.close(); }).catch(error => {
    if (cancelled) return;
    logServerError("account_export_failed", error);
    try { controller.error(new Error("account_export_failed")); } catch { /* already closed */ }
  });
  return stream;
}

export function buildAccountExport(ownerId: string, account: unknown, source: AccountExportSource, cap = FILE_BYTES_CAP): ReadableStream<Uint8Array> {
  return pacedStream(async (write, room) => {
    let finished: () => void; let failed: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => { finished = resolve; failed = reject; });
    const zip = new Zip((error, chunk, final) => {
      if (error) { failed(error); return; }
      write(chunk);
      if (final) finished();
    });
    const addWhole = (name: string, bytes: Uint8Array, compress = true) => {
      const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
      zip.add(entry);
      entry.push(bytes, true);
    };

    addWhole("README.txt", encoder.encode(README));
    addWhole("account.json", json(account));

    for (const table of await source.tables()) {
      await room();
      const entry = new ZipDeflate(`data/${table.table}.json`, { level: 6 });
      zip.add(entry);
      entry.push(encoder.encode("["));
      let first = true;
      for (let offset = 0; offset < MAX_ROWS_PER_TABLE; offset += ROW_PAGE) {
        const rows = await source.rows(table, offset, ROW_PAGE);
        for (const row of rows) {
          const kept = exportRow(table.table, row);
          if (!kept) continue;
          entry.push(encoder.encode(`${first ? "\n" : ",\n"}${JSON.stringify(kept)}`));
          first = false;
        }
        if (rows.length < ROW_PAGE) break;
        await room();
      }
      entry.push(encoder.encode("\n]\n"), true);
    }

    const files: { path: string; included: boolean; zipPath?: string; bytes?: number; reason?: string }[] = [];
    let total = 0;
    let after: string | null = null;
    while (files.length < MAX_FILES) {
      const page = await source.listFiles(after);
      if (!page.length) break;
      for (const path of page) {
        if (!path.startsWith(`${ownerId}/`)) throw new Error("account_export_file_outside_prefix");
        const relative = path.slice(ownerId.length + 1);
        if (total >= cap) { files.push({ path: relative, included: false, reason: "This download reached its size limit. The file is still in your Embel account." }); continue; }
        await room();
        try {
          const file = await source.downloadFile(path);
          total += file.bytes.byteLength;
          const zipPath = exportFileName(ownerId, path, file.mimeType);
          addWhole(zipPath, file.bytes, false);
          files.push({ path: relative, included: true, zipPath, bytes: file.bytes.byteLength });
        } catch (error) {
          logServerError("account_export_file", error);
          files.push({ path: relative, included: false, reason: "This file couldn't be read for the download." });
        }
      }
      after = page.at(-1)!;
      if (page.length < FILE_PAGE) break;
    }
    addWhole("files.json", json({ includedBytes: total, files }));
    zip.end();
    await done;
  });
}

/** The person's own data through their own login, and their files through the
 * server key, limited to their own Storage prefix. */
export function supabaseExportSource(auth: ProfileContext, admin: SupabaseClient): AccountExportSource {
  const tableSchema = z.array(z.object({ table_name: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u), key_columns: z.array(z.string()).nullable() }));
  return {
    async tables() {
      const { data, error } = await auth.client.rpc("account_export_tables");
      if (error) throw Object.assign(new Error("account_export_tables"), { code: error.code });
      return tableSchema.parse(data ?? []).map(row => ({ table: row.table_name, keyColumns: row.key_columns ?? [] }));
    },
    async rows(table, offset, limit) {
      let query = auth.client.from(table.table).select("*").eq("owner_id", auth.userId);
      for (const column of table.keyColumns) query = query.order(column, { ascending: true });
      const { data, error } = await query.range(offset, offset + limit - 1);
      // A table the person cannot read through the API is simply not part of their export.
      if (error) { logServerError("account_export_table", error, { table: table.table }); return []; }
      return z.array(z.record(z.string(), z.unknown())).parse(data ?? []);
    },
    async listFiles(after) {
      const { data, error } = await admin.rpc("account_storage_objects", { p_owner: auth.userId, p_after: after, p_limit: FILE_PAGE });
      if (error) throw Object.assign(new Error("account_export_files"), { code: error.code });
      return z.array(z.string()).parse(data ?? []);
    },
    async downloadFile(path) {
      if (!path.startsWith(`${auth.userId}/`)) throw new Error("account_export_file_outside_prefix");
      const { data, error } = await admin.storage.from("fluid-assets").download(path);
      if (error || !data) throw new Error("account_export_download");
      return { bytes: new Uint8Array(await data.arrayBuffer()), mimeType: data.type || "application/octet-stream" };
    },
  };
}

/** Rate limit (3 a day, in the database), then the streamed ZIP. */
export async function startAccountExport(signal?: AbortSignal) {
  const auth = await getProfileContext(signal);
  return { auth, open: async () => {
    // Configuration problems surface before a download is counted against the limit.
    const admin = accountAdminClient();
    const { error } = await auth.client.rpc("admit_account_export");
    if (error) {
      if (error.message === "export_rate_limited") throw new ApiError("export_rate_limited");
      throw new ApiError("integration_unavailable");
    }
    const profile = await readAccountProfile(auth);
    const account = { id: auth.userId, email: auth.email, exportedAt: new Date().toISOString(), profile: profile.values, profileUpdatedAt: profile.updatedAt };
    return buildAccountExport(auth.userId, account, supabaseExportSource(auth, admin));
  } };
}
