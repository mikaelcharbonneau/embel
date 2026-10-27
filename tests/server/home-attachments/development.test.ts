import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedContext } from "@/server/auth/context";
vi.mock("server-only", () => ({}));
const pg = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn(), constructors: vi.fn() }));
vi.mock("pg", () => { throw new Error("The development attachment runtime must not import the native-selecting pg entrypoint"); });
vi.mock("pg/lib/client.js", () => ({ default: class extends EventEmitter {
  constructor(options: unknown) { super(); pg.constructors(options); }
  connect = pg.connect; query = pg.query; end = pg.end;
} }));
import { createDevelopmentAttachmentConnectionFactory, getDevelopmentHomeAttachmentService, readDevelopmentAttachmentConfiguration } from "@/server/home-attachments/development";
import { getHomeAttachmentCapability, stageHomeAttachment } from "@/server/home-attachments";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const role = "embel_dev_attachments_test";
const environment = {
  EMBEL_DEVELOPMENT_ENABLED: "true", NODE_ENV: "test", APP_ORIGIN: "http://127.0.0.1:3105",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
  EMBEL_DEVELOPMENT_ATTACHMENTS_OWNER_ID: owner, EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_NAME: role,
  EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_OID: "12345",
  EMBEL_DEVELOPMENT_ATTACHMENTS_DATABASE_URL: `postgresql://${role}:synthetic-password@127.0.0.1:54322/postgres`,
};
const qualified = () => ({ role_name: role, effective_role: role, role_oid: 12345, owner_id: owner,
  restricted: true, no_memberships: true, owns_no_relations: true, owns_no_schemas: true,
  no_direct_data_access: true, helpers_available: true });
function auth(userId = owner, tokenOwner = userId) {
  return { userId, client: { auth: { getSession: vi.fn(async () => ({ error: null,
    data: { session: { user: { id: tokenOwner }, access_token: "synthetic.owner.jwt" } } })) }, rpc: vi.fn() } } as unknown as AuthenticatedContext;
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  pg.connect.mockResolvedValue(undefined); pg.end.mockResolvedValue(undefined);
  pg.query.mockResolvedValue({ rows: [qualified()] });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("isolated Home attachment connection selection", () => {
  it("accepts only a canonical local restricted binding without connecting", () => {
    expect(readDevelopmentAttachmentConfiguration(environment)).toMatchObject({ ownerId: owner, roleName: role, roleOid: 12345,
      database: { host: "127.0.0.1", port: 54322, user: role, ssl: false,
        options: "-c row_security=on", client_encoding: "UTF8", replication: "false" } });
    expect(pg.constructors).not.toHaveBeenCalled();
  });
  it.each([
    { EMBEL_DEVELOPMENT_ENABLED: "false" }, { NODE_ENV: "production" }, { VERCEL_ENV: "preview" },
    { EMBEL_DEVELOPMENT_ATTACHMENTS_DATABASE_URL: `postgresql://${role}:password@database.example:5432/postgres` },
    { EMBEL_DEVELOPMENT_ATTACHMENTS_DATABASE_URL: `postgresql://${role}:password@127.0.0.1:54322/postgres?options=-c%20role=postgres` },
    { EMBEL_DEVELOPMENT_ATTACHMENTS_DATABASE_URL: `postgresql://postgres:password@127.0.0.1:54322/postgres` },
    { EMBEL_DEVELOPMENT_ATTACHMENTS_DATABASE_URL: `postgresql://${role}:password@127.0.0.1:54321/postgres` },
    { EMBEL_DEVELOPMENT_ATTACHMENTS_DATABASE_URL: `postgresql://${role}:password@127.0.0.1:3105/postgres` },
    { EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_NAME: "fluid_naming_brain_worker" },
    { EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_OID: "012345" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://production.example" },
  ])("rejects a hosted, privileged or ambiguous binding: %j", change => {
    expect(readDevelopmentAttachmentConfiguration({ ...environment, ...change })).toBeNull();
    expect(pg.constructors).not.toHaveBeenCalled();
  });
  it("does not advertise a capability for missing binding, foreign auth or connection failure", async () => {
    vi.stubEnv("EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_OID", "");
    expect(await getHomeAttachmentCapability(auth())).toBeNull();
    expect(pg.connect).not.toHaveBeenCalled();
    vi.stubEnv("EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_OID", "12345");
    expect(await getDevelopmentHomeAttachmentService(auth(other))).toBeNull();
    expect(pg.connect).not.toHaveBeenCalled();
    pg.connect.mockRejectedValue(new Error("private connection diagnostic"));
    expect(await getHomeAttachmentCapability(auth())).toBeNull();
    expect(pg.end).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["restricted","no_memberships","owns_no_relations","owns_no_schemas","no_direct_data_access","helpers_available"])(
    "requires actual read-only %s qualification", async property => {
      pg.query.mockResolvedValue({ rows: [{ ...qualified(), [property]: false }] });
      expect(await getDevelopmentHomeAttachmentService(auth())).toBeNull();
      expect(pg.query.mock.calls[0]![0]).toContain("fluid_private.home_attachment_owner()");
      expect(pg.end).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    });
  it.each([{ owner_id: other }, { role_oid: 99999 }, { effective_role: "postgres" }])("rejects actual changed principal: %j", async change => {
    pg.query.mockResolvedValue({ rows: [{ ...qualified(), ...change }] });
    expect(await getDevelopmentHomeAttachmentService(auth())).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a mismatched session token and a failed qualification release", async () => {
    expect(await getDevelopmentHomeAttachmentService(auth(owner, other))).toBeNull();
    pg.end.mockRejectedValue(new Error("private release diagnostic"));
    expect(await getDevelopmentHomeAttachmentService(auth())).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps production unavailable even with complete local binding values", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await getHomeAttachmentCapability(auth())).toBeNull();
    await expect(stageHomeAttachment(auth(), { requestKey: other, name: "note.txt", mimeType: "text/plain", contentHash: "a".repeat(64) }, new Uint8Array([1]))).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(pg.connect).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("pins the real JavaScript driver's connection parameters despite native and PG option environment overrides", async () => {
    vi.stubEnv("NODE_PG_FORCE_NATIVE", "true"); vi.stubEnv("PGOPTIONS", "-c row_security=off -c role=postgres");
    vi.stubEnv("PGCLIENT_ENCODING", "SQL_ASCII"); vi.stubEnv("PGREPLICATION", "database");
    const configuration = readDevelopmentAttachmentConfiguration(environment)!;
    const { default: ActualJavaScriptClient } = await vi.importActual<typeof import("pg/lib/client.js")>("pg/lib/client.js");
    const actual = new ActualJavaScriptClient(configuration.database);
    expect((actual as unknown as { connectionParameters: unknown }).connectionParameters).toMatchObject({
      host: "127.0.0.1", port: 54322, user: role, database: "postgres", ssl: false,
      options: "-c row_security=on", client_encoding: "UTF8", replication: "false",
    });
    const lease = await createDevelopmentAttachmentConnectionFactory(configuration).acquire(owner);
    expect(pg.constructors).toHaveBeenCalledWith(expect.objectContaining({ options: "-c row_security=on", replication: "false" }));
    await lease.connection.release(false);
  });
  it("closes an aborted late connection and never returns a usable lease", async () => {
    let connected!: () => void;
    pg.connect.mockImplementation(() => new Promise<void>(resolve => { connected = resolve; }));
    const configuration = readDevelopmentAttachmentConfiguration(environment)!;
    const factory = createDevelopmentAttachmentConnectionFactory(configuration), controller = new AbortController();
    const pending = factory.acquire(owner, controller.signal);
    controller.abort(); connected();
    await expect(pending).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(pg.end).toHaveBeenCalledOnce(); expect(pg.query).not.toHaveBeenCalled();
  });
});

describe("Home adapter uses real verified-byte lifecycle with isolated synthetic transports", () => {
  it("qualifies metadata, uploads create-only with the authenticated JWT and reads back exact bytes before observing", async () => {
    const bytes = new TextEncoder().encode("A private local development brief.\n");
    const requestKey = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ref = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ownerId: owner, projectId: null, projectRevision: null,
      blobVersionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", contentHash: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "text/plain", byteLength: bytes.byteLength, name: "brief.txt", sourceReceiptId: "ffffffff-ffff-4fff-8fff-ffffffffffff", state: "staged" };
    const path = `${owner}/home/${ref.id}/${ref.blobVersionId}`, events: string[] = [];
    const reservation = { requestKey, ref, storagePath: path, verified: false };
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes("effective_role")) return { rows: [qualified()] };
      if (sql.includes("AS role_name")) return { rows: [{ role_name: role, role_oid: 12345, owner_id: owner }] };
      if (sql.includes("prepare_home_attachment")) { events.push("prepare"); return { rows: [{ value: reservation }] }; }
      if (sql.includes("observe_home_attachment")) { events.push("observe"); return { rows: [{ value: ref }] }; }
      throw Error("Unexpected SQL");
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      expect(String(input)).toBe(`http://127.0.0.1:54321/storage/v1/object/fluid-assets/${path}`);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer synthetic.owner.jwt");
      expect(headers.get("apikey")).toBe("sb_publishable_synthetic");
      expect(init?.redirect).toBe("error");
      if (init?.method === "POST") {
        events.push("upload"); expect(headers.get("x-upsert")).toBe("false");
        expect(new Uint8Array(init.body as Uint8Array)).toEqual(bytes);
        return Response.json({ Id: ref.id, Key: `fluid-assets/${path}` });
      }
      events.push("read"); return new Response(bytes, { headers: { "content-type": "text/plain", "content-length": String(bytes.byteLength) } });
    });
    const service = await getDevelopmentHomeAttachmentService(auth());
    expect(service?.getHomeAttachmentCapability()?.allowedMimeTypes).toEqual(["text/plain","image/png","image/jpeg"]);
    expect(await service?.stageHomeAttachment(auth(), { requestKey, name: ref.name, mimeType: "text/plain", contentHash: ref.contentHash }, bytes)).toEqual(ref);
    expect(events).toEqual(["prepare","upload","read","observe"]);
    expect(pg.connect).toHaveBeenCalledTimes(3); expect(pg.end).toHaveBeenCalledTimes(3);
  });
});
