import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("@/server/account/export", async importOriginal => {
  const actual = await importOriginal<typeof import("@/server/account/export")>();
  return { ...actual, startAccountExport: mock.start };
});
import { strFromU8, unzipSync } from "fflate";
import { POST } from "@/app/api/account/export/route";
import { GET as cleanup } from "@/app/api/maintenance/account-cleanup/route";
import { buildAccountExport, exportFileName, exportRow, type AccountExportSource } from "@/server/account/export";
import { assertMaintenanceCaller, purgeOrphanedFiles, resumePendingDeletions } from "@/server/account/maintenance";
import { ApiError } from "@/server/http/errors";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function readAll(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function source(files: Record<string, Uint8Array>, overrides: Partial<AccountExportSource> = {}): AccountExportSource {
  return {
    tables: async () => [{ table: "projects", keyColumns: ["id"] }, { table: "generation_outputs", keyColumns: ["id"] }],
    rows: async (table, offset) => offset > 0 ? [] : table.table === "projects"
      ? [{ id: "p1", owner_id: A, title: "Bright Oak", created_at: "2026-11-01T00:00:00Z" }]
      : [{ id: 1, run_id: "r1", output_key: "names", output: { names: ["Oakly"] }, cost_microusd: 900, provider_response_id: "resp_1" },
         { id: 2, run_id: "r1", output_key: "sent.names", output: {}, cost_microusd: 0 }],
    listFiles: async after => after ? [] : Object.keys(files),
    downloadFile: async path => ({ bytes: files[path]!, mimeType: "image/png" }),
    ...overrides,
  };
}

describe("export archive", () => {
  it("contains the account, every owned row without internal costs, and the files", async () => {
    const files = { [`${A}/p1/asset/v1`]: new Uint8Array([137, 80, 78, 71]), [`${A}/home/h1/v1`]: new Uint8Array([1, 2, 3]) };
    const zip = unzipSync(await readAll(buildAccountExport(A, { id: A, email: "owner@example.invalid" }, source(files))));
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(["README.txt", "account.json", "data/projects.json", "data/generation_outputs.json", "files.json", "files/p1/asset/v1.png", "files/home/h1/v1.png"]));
    expect(JSON.parse(strFromU8(zip["account.json"]!))).toMatchObject({ id: A, email: "owner@example.invalid" });
    expect(JSON.parse(strFromU8(zip["data/projects.json"]!))).toEqual([{ id: "p1", owner_id: A, title: "Bright Oak", created_at: "2026-11-01T00:00:00Z" }]);
    const outputs = strFromU8(zip["data/generation_outputs.json"]!);
    expect(JSON.parse(outputs)).toEqual([{ id: 1, run_id: "r1", output_key: "names", output: { names: ["Oakly"] } }]);
    expect(outputs).not.toMatch(/cost|resp_1|sent\./);
    expect(Array.from(zip["files/p1/asset/v1.png"]!)).toEqual([137, 80, 78, 71]);
    expect(JSON.parse(strFromU8(zip["files.json"]!))).toMatchObject({ includedBytes: 7 });
  });

  it("lists files past the size cap instead of including them, and records unreadable files", async () => {
    const files: Record<string, Uint8Array> = { [`${A}/p1/a/1`]: new Uint8Array(10), [`${A}/p1/a/2`]: new Uint8Array(10), [`${A}/p1/a/3`]: new Uint8Array(10), [`${A}/p1/a/4`]: new Uint8Array(10) };
    const zip = unzipSync(await readAll(buildAccountExport(A, {}, source(files, {
      downloadFile: async path => { if (path.endsWith("/2")) throw new Error("unreadable"); return { bytes: files[path]!, mimeType: "image/png" }; },
    }), 15)));
    const manifest = JSON.parse(strFromU8(zip["files.json"]!)) as { files: { path: string; included: boolean; reason?: string }[] };
    // 1 fits, 2 can't be read, 3 still starts under the cap, 4 is past it.
    expect(manifest.files.map(file => [file.path, file.included])).toEqual([["p1/a/1", true], ["p1/a/2", false], ["p1/a/3", true], ["p1/a/4", false]]);
    expect(zip["files/p1/a/3.png"]).toBeDefined();
    expect(zip["files/p1/a/4.png"]).toBeUndefined();
  });

  it("fails the download rather than include a file outside the person's prefix", async () => {
    const stream = buildAccountExport(A, {}, source({ [`${B}/p/a/v`]: new Uint8Array(1) }));
    await expect(readAll(stream)).rejects.toThrow();
  });

  it("names files safely and drops internal fields", () => {
    expect(exportFileName(A, `${A}/p/../a/v`, "image/webp; q=1")).toBe("files/p/a/v.webp");
    expect(exportFileName(A, `${A}/p/a/v`, "application/x-unknown")).toBe("files/p/a/v");
    expect(exportRow("jobs", { id: 1, lease_token: "t", reserved_cost_microusd: 5, workflow_run_id: "w", idempotency_key: "k", title: "x" })).toEqual({ id: 1, title: "x" });
  });
});

describe("export route", () => {
  const request = (headers: Record<string, string> = {}) => new Request("http://localhost:3105/api/account/export", { method: "POST",
    headers: { origin: "http://localhost:3105", "content-type": "application/json", "X-Embel-Account": A, ...headers }, body: "{}" });
  const open = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "http://localhost:3105");
    open.mockResolvedValue(new Response("zip").body);
    mock.start.mockResolvedValue({ auth: { userId: A }, open });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("streams a private ZIP for the signed-in account only", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="embel-data-\d{4}-\d{2}-\d{2}\.zip"$/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses another captured account and cross-site requests before anything is counted", async () => {
    expect((await POST(request({ "X-Embel-Account": B }))).status).toBe(401);
    expect((await POST(request({ origin: "https://foreign.invalid" }))).status).toBe(403);
    expect(open).not.toHaveBeenCalled();
  });

  it("answers 429 once the daily limit is reached", async () => {
    open.mockRejectedValueOnce(new ApiError("export_rate_limited"));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("export_rate_limited");
  });
});

describe("cleanup job", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("requires the cron secret", async () => {
    const secret = "s".repeat(32);
    const call = (value?: string) => new Request("http://localhost:3105/api/maintenance/account-cleanup", { headers: value ? { authorization: value } : {} });
    expect(() => assertMaintenanceCaller(call(`Bearer ${secret}`), secret)).not.toThrow();
    for (const value of [undefined, `Bearer ${"x".repeat(32)}`, secret]) expect(() => assertMaintenanceCaller(call(value), secret)).toThrow(ApiError);
    expect(() => assertMaintenanceCaller(call(`Bearer ${secret}`), undefined)).toThrow(ApiError);
    vi.stubEnv("CRON_SECRET", secret);
    expect((await cleanup(call("Bearer wrong"))).status).toBe(401);
  });

  it("removes orphans page by page and resumes pending deletions without stopping at a failure", async () => {
    const pages = [["x/1", "x/2"], ["x/3"], []];
    const removed: string[][] = [];
    expect(await purgeOrphanedFiles({ listOrphans: async () => pages.shift() ?? [], removeFiles: async paths => { removed.push(paths); return paths.length; } })).toBe(3);
    const run = vi.fn();
    const store = { begin: run, purge: vi.fn(async () => 0), listFiles: vi.fn(async () => []), removeFiles: vi.fn(), recordFilesRemoved: vi.fn(), deleteAuthUser: vi.fn(async () => undefined), complete: vi.fn(async () => undefined) };
    run.mockRejectedValueOnce(new Error("first fails"));
    expect(await resumePendingDeletions(async () => [A, B], store)).toEqual({ finished: 1, failed: 1 });
    expect(store.complete).toHaveBeenCalledWith(B);
  });
});
