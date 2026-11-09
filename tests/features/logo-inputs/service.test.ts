import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "../../database/local-supabase";
import type { LogoWorkspaceV2 } from "@/domain/logo-workspace";
import { fontPurposeAllowed } from "@/features/identity-directions/model/font-rights";
import { createFontResolver, readFreeCatalogFont } from "@/features/identity-directions/server/fonts";
import { createIdentityAssetStore, createPostgresIdentityAssetBackend } from "@/server/data/identity-asset-store";
import { isLogoFontLicenseUrl } from "@/features/logo-inputs/model/contracts";
import { createLogoInputService, validateLogoInputBytes } from "@/server/data/logo-inputs";
import type { IdentityConnectionFactory } from "@/server/data/identity-transaction";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ownerQuery, startLogoFixture } from "../../database/logo-project-fixture";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const role = "fixture_logo_inputs_a";
const brief = { name: "Owned inputs", activity: "Studio", audience: "Founders", personality: "Calm", logoTypes: ["wordmark"] };
describe("owned reference and font registrations with actual bytes", () => {
  let db: TestDatabase, workspace: LogoWorkspaceV2, png: Uint8Array;
  let objects: Map<string, { bytes: Uint8Array; mimeType: string }>, writes: number;
  let failRelease: boolean, afterPut: (() => Promise<void>) | null;
  beforeAll(async () => {
    db = await createTestDatabase();
    await db.exec(`create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public, fluid_private to ${role};
      grant execute on function fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid),
        fluid_private.prepare_logo_input(uuid,jsonb),fluid_private.commit_logo_input(uuid,jsonb,jsonb,jsonb) to ${role};`);
    await db.query("insert into fluid_private.logo_asset_web_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2", [OWNER_A, role]);
    png = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 4, background: "#cc2277" } }).png().toBuffer());
  }, 40_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await resetFixture(db); objects = new Map(); writes = 0; failRelease = false; afterPut = null;
    workspace = await startLogoFixture(ownerQuery(db), { requestKey: randomUUID(), brief });
  });
  async function rpc(name: string, args: Record<string, unknown>, owner = OWNER_A): Promise<unknown> {
    return asRole(db, "authenticated", owner, async () => (await db.query<{ value: unknown }>(`select public.${name}(${Object.keys(args).map((_, index) => `$${index + 1}`).join(",")}) value`, Object.values(args))).rows[0]!.value);
  }
  function auth(owner = OWNER_A): AuthenticatedContext {
    return { userId: owner, client: { rpc(name: string, args: Record<string, unknown>) {
      const run = async () => { try { return { data: await rpc(name, args, owner), error: null }; } catch (error) { return { data: null, error }; } };
      const result = run(); return Object.assign(result, { abortSignal: () => result });
    } } } as unknown as AuthenticatedContext;
  }
  const connections: IdentityConnectionFactory = { async acquire(ownerId) {
    const roleOid = (await db.query<{ oid: number }>("select oid::int from pg_roles where rolname=$1", [role])).rows[0]!.oid;
    if (ownerId !== OWNER_A) throw Object.assign(Error("Fixture owner mismatch"), { code: "P0002" });
    await db.exec(`set session authorization ${role}`);
    return { binding: { ownerId: OWNER_A, roleName: role, roleOid }, connection: {
      query: (sql, parameters) => db.query(sql, parameters ? [...parameters] : undefined),
      async release() { await db.exec("set session authorization postgres"); if (failRelease) { failRelease = false; throw Error("Lost acknowledgement"); } },
      async discard() { await db.exec("set session authorization postgres"); },
    } };
  } };
  function fixture() {
    const store = createIdentityAssetStore({ backend: createPostgresIdentityAssetBackend({ owned: connections, worker: null }), validateBytes: validateLogoInputBytes,
      storage: { async putIfAbsent(path, bytes, mimeType) { writes++; if (!objects.has(path)) objects.set(path, { bytes: bytes.slice(), mimeType }); if (afterPut) { const action = afterPut; afterPut = null; await action(); } },
        async read(path) { const value = objects.get(path); if (!value) throw Error("Object missing"); return { bytes: value.bytes.slice(), mimeType: value.mimeType }; } } });
    return { store, service: createLogoInputService({ assets: store, connections }) };
  }
  const referenceInput = () => ({ requestKey: randomUUID(), expected: workspace.heads, aspects: ["shape" as const], rightsDeclaration: "I own this image and permit its display and processing for my logo." });
  async function count(table: string) { return (await db.query<{ count: number }>(`select count(*)::int count from public.${table}`)).rows[0]!.count; }
  it("registers decoded owned image bytes without selecting or modifying saved heads", async () => {
    const f = fixture(), input = referenceInput();
    const ref = await f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png");
    expect(ref).toMatchObject({ sourceKind: "upload", aspects: ["shape"], asset: { ownerId: OWNER_A, projectId: workspace.projectId, contentHash: sha(png) }, workspace: { heads: workspace.heads } });
    expect((await f.store.readOwnedAsset(auth(), ref.asset)).bytes).toEqual(png);
    expect((await f.service.listLogoReferences(auth(), workspace.projectId)).items).toEqual([ref]);
    expect(await count("logo_reference_sources")).toBe(1);
    expect(await f.service.readLogoInputRequest(auth(), workspace.projectId, input.requestKey)).toMatchObject({ status: "succeeded", request: { kind: "reference_upload", input, file: { contentHash: sha(png), mimeType: "image/png", byteLength: png.length } }, result: ref });
    const saved = await rpc("apply_logo_workspace_command", { p_project_id: workspace.projectId, p_command: { method: "saveLogoReferences", body: { requestKey: randomUUID(), expected: workspace.heads, selections: [{ referenceId: ref.referenceId, aspects: ["lettering", "shape"] }] } } });
    expect(saved).toMatchObject({ workspace: { heads: { workspaceRevision: workspace.heads.workspaceRevision + 1 } } });
  });
  it("replays exact key after heads change and never allocates a replacement object", async () => {
    const f = fixture(), input = referenceInput(), ref = await f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png");
    await rpc("apply_logo_workspace_command", { project: workspace.projectId, command: { method: "saveLogoBrief", body: { requestKey: randomUUID(), expected: workspace.heads, brief: { ...brief, name: "Changed" } } } });
    expect(await f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png")).toEqual(ref);
    expect(writes).toBe(1); expect(await count("asset_versions")).toBe(1);
    for (const changed of [{ ...input, aspects: ["overall_feel"] }, { ...input, rightsDeclaration: "Another declaration" }]) await expect(f.service.uploadLogoReference(auth(), workspace.projectId, changed, png, "image/png")).rejects.toMatchObject({ code: "conflict" });
  });
  it("rejects HTML renamed PNG, MIME mismatch, empty declarations and foreign uploads before objects", async () => {
    const f = fixture(), input = referenceInput();
    for (const [bytes, mime] of [[new TextEncoder().encode("<html>not an image</html>"), "image/png"], [png, "image/jpeg"], [png, "image/svg+xml"]] as const) await expect(f.service.uploadLogoReference(auth(), workspace.projectId, input, bytes, mime)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(f.service.uploadLogoReference(auth(), workspace.projectId, { ...input, rightsDeclaration: "   " }, png, "image/png")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(f.service.uploadLogoReference(auth(OWNER_B), workspace.projectId, input, png, "image/png")).rejects.toMatchObject({ code: "not_found" });
    expect(writes).toBe(0); expect(await count("logo_input_requests")).toBe(0);
  });
  it("head conflict after immutable upload records immutable rejection without registering a stale source", async () => {
    const f = fixture(), input = referenceInput();
    afterPut = async () => { await rpc("apply_logo_workspace_command", { project: workspace.projectId, command: { method: "saveLogoBrief", body: { requestKey: randomUUID(), expected: workspace.heads, brief: { ...brief, name: "New head" } } } }); };
    await expect(f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png")).rejects.toMatchObject({ code: "conflict" });
    expect(await count("logo_reference_sources")).toBe(0); expect(await count("asset_versions")).toBe(1);
    expect(await f.service.readLogoInputRequest(auth(), workspace.projectId, input.requestKey)).toMatchObject({ status: "rejected", reason: "inputs_changed", request: { input } });
  });
  it("lost reservation acknowledgement is uncertain and read-only recovery does not upload", async () => {
    const f = fixture(), input = referenceInput(); failRelease = true;
    await expect(f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png")).rejects.toMatchObject({ name: "LogoInputUncertainCommitError", requestKey: input.requestKey });
    expect(await f.service.readLogoInputRequest(auth(), workspace.projectId, input.requestKey)).toMatchObject({ status: "pending" }); expect(writes).toBe(0);
    await f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png"); expect(writes).toBe(1);
  });
  it("lists only the reviewed installed catalog and registers exact font/license bytes", async () => {
    const f = fixture(), catalog = await f.service.listCatalogLogoFonts(auth(), workspace.projectId);
    expect(catalog).toHaveLength(4);
    const source = await readFreeCatalogFont(catalog[0]!.id);
    const input = { requestKey: randomUUID(), expected: workspace.heads, catalogFontId: source.id };
    const font = await f.service.importCatalogLogoFont(auth(), workspace.projectId, input);
    expect(font).toMatchObject({ family: source.family, source: "free_catalog", asset: { contentHash: source.contentHash }, rights: { sourceKind: "reviewed_license", licenseTextHash: sha(source.licenseText), permissions: { render: "allowed", embed: "allowed", redistribute: "allowed" } } });
    expect((await f.service.listLogoFonts(auth(), workspace.projectId))).toEqual([font]);
    const resolve = createFontResolver({ store: f.store, loadRecord: async () => font });
    expect((await resolve(auth(), font.id, "outline")).bytes).toEqual(source.bytes);
    expect(await f.service.importCatalogLogoFont(auth(), workspace.projectId, input)).toEqual(font); expect(writes).toBe(1);
  });
  it("retains uploaded license bytes and never promotes an uploaded known font to a reviewed license", async () => {
    const f = fixture(), source = await readFreeCatalogFont("geist-sans-variable");
    const input = { requestKey: randomUUID(), expected: workspace.heads, licenseSourceUrl: source.rights.sourceUrl, licenseText: source.licenseText, rightsDeclaration: "I have permission to use and upload this font and its license." };
    const font = await f.service.uploadLogoFont(auth(), workspace.projectId, input, source.bytes, "font/ttf");
    expect(font).toMatchObject({ family: "Geist", source: "user_upload", rights: { sourceKind: "user_declaration", commercialUse: "unknown", reviewedAt: null, permissions: { render: "unknown", outline: "unknown", embed: "unknown", modify: "unknown", redistribute: "unknown" } } });
    expect(fontPurposeAllowed(font, "render")).toBe(false);
    const rights = (await db.query<{ license_text: string; rights_declaration: string }>("select license_text,rights_declaration from public.logo_input_rights where id=$1", [font.rights.id])).rows[0]!;
    expect(rights).toEqual({ license_text: source.licenseText, rights_declaration: input.rightsDeclaration });
    await expect(f.service.uploadLogoFont(auth(), workspace.projectId, { ...input, licenseText: "Different terms" }, source.bytes, "font/ttf")).rejects.toMatchObject({ code: "conflict" });
    await expect(f.service.uploadLogoFont(auth(), workspace.projectId, { ...input, requestKey: randomUUID(), permissions: { render: "allowed" } }, source.bytes, "font/ttf")).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("rejects malformed font containers, corrupt catalog IDs and unsafe source URLs without registering", async () => {
    const f = fixture(), input = { requestKey: randomUUID(), expected: workspace.heads, licenseSourceUrl: null, licenseText: "Actual supplied terms", rightsDeclaration: "I have permission." };
    await expect(f.service.uploadLogoFont(auth(), workspace.projectId, input, png, "font/ttf")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(f.service.uploadLogoFont(auth(), workspace.projectId, { ...input, licenseSourceUrl: "https://user:secret@example.com/license" }, png, "font/ttf")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(f.service.importCatalogLogoFont(auth(), workspace.projectId, { requestKey: randomUUID(), expected: workspace.heads, catalogFontId: "paid-font" })).rejects.toMatchObject({ code: "not_found" });
    expect(await count("logo_font_records")).toBe(0); expect(writes).toBe(0);
  });
  it("read/list and trusted writer boundaries reject other owners, public writers and forged login claims", async () => {
    const f = fixture(), input = referenceInput(); await f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png");
    await expect(f.service.listLogoReferences(auth(OWNER_B), workspace.projectId)).rejects.toMatchObject({ code: "not_found" });
    await expect(f.service.listLogoFonts(auth(OWNER_B), workspace.projectId)).rejects.toMatchObject({ code: "not_found" });
    await expect(f.service.readLogoInputRequest(auth(OWNER_B), workspace.projectId, input.requestKey)).rejects.toMatchObject({ code: "not_found" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select fluid_private.prepare_logo_input($1,'{}')", [workspace.projectId]))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("insert into public.logo_input_rights(id,owner_id,project_id) values(gen_random_uuid(),$1,$2)", [OWNER_A, workspace.projectId]))).rejects.toMatchObject({ code: "42501" });
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_A]);
    await expect(db.query("select fluid_private.prepare_logo_input($1,'{}')", [workspace.projectId])).rejects.toMatchObject({ code: "42501" });
  });
  it("discovers unresolved requests after reload with owner-bound pagination", async () => {
    const f = fixture(), input = referenceInput(); failRelease = true;
    await expect(f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png")).rejects.toBeDefined();
    expect(await f.service.listLogoInputRequests(auth(), workspace.projectId)).toMatchObject({ ownerId: OWNER_A, projectId: workspace.projectId, items: [{ status: "pending", requestKey: input.requestKey }], nextCursor: null });
    await expect(f.service.listLogoInputRequests(auth(OWNER_B), workspace.projectId)).rejects.toMatchObject({ code: "not_found" });
    await f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png");
    expect((await f.service.listLogoInputRequests(auth(), workspace.projectId)).items).toEqual([]);
  });
  it("the injected input validator never greenlights an unsupported file MIME", async () => {
    await expect(validateLogoInputBytes({ kind: "upload", intent: { requestKey: randomUUID(), usage: "font", mimeType: "application/octet-stream", contentHash: sha(png), rightsDeclaration: "Permission" }, byteLength: png.length }, png)).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("SQL independently rejects null discriminants and MIME instead of treating unknown as valid", async () => {
    const source = await readFreeCatalogFont("geist-sans-variable"), input = { requestKey: randomUUID(), expected: workspace.heads, licenseSourceUrl: null, licenseText: "Terms", rightsDeclaration: "Permission" };
    const request = { kind: "font_upload", input, file: { contentHash: source.contentHash, byteLength: source.bytes.length, mimeType: "font/ttf" } };
    for (const invalid of [{ ...request, kind: null }, { ...request, kind: 42 }, { input, file: request.file }, { ...request, file: { ...request.file, mimeType: null } }, { ...request, file: { ...request.file, mimeType: 42 } }, { ...request, file: { contentHash: source.contentHash, byteLength: source.bytes.length } }]) {
      const value = (await db.query<{ valid: boolean }>("select fluid_private.logo_input_request_valid($1) valid", [invalid])).rows[0]!.valid;
      expect(value).toBe(false);
    }
  });
  it("can explicitly fence an absent exact request and reject delayed prepare without allocating bytes", async () => {
    const f = fixture(), input = referenceInput(), request = { kind: "reference_upload", input, file: { contentHash: sha(png), mimeType: "image/png", byteLength: png.length } };
    const cancelled = await f.service.cancelLogoInputRequest(auth(), workspace.projectId, request);
    expect(cancelled).toMatchObject({ status: "rejected", reason: "cancelled_by_user", request });
    expect(await f.service.cancelLogoInputRequest(auth(), workspace.projectId, request)).toEqual(cancelled);
    await expect(f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png")).rejects.toMatchObject({ code: "conflict" });
    await expect(f.service.cancelLogoInputRequest(auth(), workspace.projectId, { ...request, input: { ...input, aspects: ["lettering"] } })).rejects.toMatchObject({ code: "conflict" });
    await expect(f.service.cancelLogoInputRequest(auth(OWNER_B), workspace.projectId, request)).rejects.toMatchObject({ code: "not_found" });
    expect(writes).toBe(0); expect(await count("logo_reference_sources")).toBe(0);
  });
  it("cancellation during immutable object I/O prevents registration and preserves uploaded bytes", async () => {
    const f = fixture(), input = referenceInput(), request = { kind: "reference_upload", input, file: { contentHash: sha(png), mimeType: "image/png", byteLength: png.length } };
    afterPut = async () => { expect(await f.service.cancelLogoInputRequest(auth(), workspace.projectId, request)).toMatchObject({ status: "rejected" }); };
    await expect(f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png")).rejects.toMatchObject({ code: "conflict" });
    expect(await count("asset_versions")).toBe(1); expect(objects.size).toBe(1); expect(await count("logo_reference_sources")).toBe(0);
  });
  it("cancelling an already successful input returns that unchanged success", async () => {
    const f = fixture(), input = referenceInput(), reference = await f.service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png");
    const request = { kind: "reference_upload", input, file: { contentHash: sha(png), mimeType: "image/png", byteLength: png.length } };
    expect(await f.service.cancelLogoInputRequest(auth(), workspace.projectId, request)).toMatchObject({ status: "succeeded", result: reference });
    expect(await count("logo_input_rejections")).toBe(0); expect(await count("logo_reference_sources")).toBe(1);
  });
  it("cancels former client URL spellings unchanged while new registration rejects them", async () => {
    const f = fixture(), source = await readFreeCatalogFont("geist-sans-variable");
    for (const licenseSourceUrl of ["HTTPS://example.com/license", "https://[::1]/license", "https://example.com/license?"]) {
      const input = { requestKey: randomUUID(), expected: workspace.heads, licenseSourceUrl, licenseText: "Actual license", rightsDeclaration: "I have permission." };
      const request = { kind: "font_upload", input, file: { contentHash: source.contentHash, byteLength: source.bytes.length, mimeType: "font/ttf" } };
      await expect(f.service.uploadLogoFont(auth(), workspace.projectId, input, source.bytes, "font/ttf")).rejects.toMatchObject({ code: "invalid_input" });
      expect(await f.service.cancelLogoInputRequest(auth(), workspace.projectId, request)).toMatchObject({ status: "rejected", reason: "cancelled_by_user", request });
    }
    expect(await count("logo_font_records")).toBe(0);
  });
  it("matches TypeScript and SQL for the documented conservative license URL subset", async () => {
    const source = await readFreeCatalogFont("geist-sans-variable");
    const accepted = ["https://github.com/vercel/geist-font/blob/main/OFL.txt", "https://fonts.example:65535/licenses/OFL%20License.txt", "https://localhost/license", "https://Fonts.example:443/OFL.txt"];
    const rejected = ["HTTPS://example.com/license", "https://[::1]/license", "https://example.com/license?", "https://example.com/license#", "https://example.com/license?token=one", "https://user:pass@example.com/license", "https://éxample.com/license", "https://example.com:0/license", "https://example.com:65536/license", "https://example.com/license\n", " https://example.com/license", "https://-invalid.example/license", "https://127.0.0.1/license"];
    for (const url of [...accepted, ...rejected]) {
      const request = { kind: "font_upload", input: { requestKey: randomUUID(), expected: workspace.heads, licenseSourceUrl: url, licenseText: "Terms", rightsDeclaration: "Permission" }, file: { contentHash: source.contentHash, byteLength: source.bytes.length, mimeType: "font/ttf" } };
      const sql = (await db.query<{ valid: boolean }>("select fluid_private.logo_input_request_valid($1) valid", [request])).rows[0]!.valid;
      expect(isLogoFontLicenseUrl(url), `TypeScript ${JSON.stringify(url)}`).toBe(accepted.includes(url)); expect(sql, `SQL ${JSON.stringify(url)}`).toBe(accepted.includes(url));
    }
  });
  it("registers every shipped upright and italic catalog font through actual metadata inspection", async () => {
    const f = fixture(), catalog = await f.service.listCatalogLogoFonts(auth(), workspace.projectId);
    for (const entry of catalog) {
      const font = await f.service.importCatalogLogoFont(auth(), workspace.projectId, { requestKey: randomUUID(), expected: workspace.heads, catalogFontId: entry.id });
      expect(font.family).toBe(entry.family); expect(font.asset.contentHash).toBe(entry.rights.fontContentHash); expect(font.rights.licenseTextHash).toBe(entry.rights.licenseTextHash);
    }
    expect(await count("logo_font_records")).toBe(4);
  });
  it("unconfigured stores and cancelled requests remain unavailable without inferred imports", async () => {
    const service = createLogoInputService(null), input = referenceInput();
    await expect(service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png")).rejects.toMatchObject({ code: "integration_unavailable" });
    const controller = new AbortController(); controller.abort();
    await expect(fixture().service.uploadLogoReference(auth(), workspace.projectId, input, png, "image/png", controller.signal)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(writes).toBe(0);
  });
});
