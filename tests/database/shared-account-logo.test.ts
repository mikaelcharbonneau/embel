import { randomUUID, createHash } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedLogoFixture, sharedLogoRole, type SharedLogoFixture } from "./shared-account-logo-fixture";
import { OWNER_A, OWNER_B } from "./local-supabase";
import { sharedLogoHttpHelperHashes, sharedLogoAdvancedHelperSignatures } from "../../src/server/shared-account/logo-qualification";
import { createLogoServices } from "../../src/server/runtime/logo-services";
import sharp from "sharp";
let png: Uint8Array, hash: string;
const write = () => ({ kind: "upload", intent: { requestKey: randomUUID(), usage: "logo_reference", mimeType: "image/png", contentHash: hash, rightsDeclaration: "My original fixture" }, byteLength: png.length });
describe("shared Logo web verified intent and trusted byte/command authority", () => {
  let f: SharedLogoFixture;
  beforeAll(async () => { f = await createSharedLogoFixture(); png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 22, g: 44, b: 66, alpha: 1 } } }).png().toBuffer()); hash = createHash("sha256").update(png).digest("hex"); }, 90_000);
  afterAll(async () => { vi.unstubAllEnvs(); await f?.db.close(); });
  it("installs an independent exact purpose surface without customer credentials or direct data access", async () => {
    for (const [signature, hashes] of Object.entries(sharedLogoHttpHelperHashes)) {
      const record = (await f.db.query<{ body: string }>("select prosrc body from pg_proc where oid=to_regprocedure($1)", [signature])).rows[0];
      if ((signature === "fluid_private.quote_logo_vector_proposal(uuid,jsonb)" || sharedLogoAdvancedHelperSignatures.includes(signature)) && !record) continue;
      const body = record!.body;
      expect(hashes, signature).toContain(createHash("sha256").update(body).digest("hex"));
    }
    await expect(f.asSession(sharedLogoRole, () => f.db.exec("set role authenticated"))).rejects.toMatchObject({ code: "42501" });
    await expect(f.asSession(sharedLogoRole, () => f.db.query("select * from public.projects"))).rejects.toMatchObject({ code: "42501" });
    await expect(f.asSession(sharedLogoRole, () => f.db.query("select * from fluid_private.shared_logo_http_requests"))).rejects.toMatchObject({ code: "42501" });
  });
  it("two customers use one fixed verifier, with exact args/replay and foreign project/readback denial", async () => {
    const a = await f.start(OWNER_A), b = await f.start(OWNER_B), intent = write();
    const first = await f.executeLogo(OWNER_A, "asset_prepare", a.projectId, intent) as { id: string; reference: { ownerId: string } };
    expect(first.reference.ownerId).toBe(OWNER_A); expect(await f.executeLogo(OWNER_A, "asset_prepare", a.projectId, intent)).toEqual(first);
    expect(await f.executeLogo(OWNER_B, "asset_prepare", b.projectId, intent)).toMatchObject({ reference: { ownerId: OWNER_B } });
    await expect(f.issueLogo(OWNER_B, "asset_prepare", a.projectId, intent)).rejects.toMatchObject({ code: "P0002" });
    await expect(f.issueLogo(OWNER_B, "asset_readback", b.projectId, first.id)).rejects.toMatchObject({ code: "P0002" });
    const cap = await f.issueLogo(OWNER_A, "asset_prepare", a.projectId, intent);
    await expect(f.asSession(sharedLogoRole, () => f.db.query("select public.execute_shared_logo_request($1,'asset_prepare',$2::jsonb,null)", [cap.token, JSON.stringify([b.projectId, intent])]))).rejects.toMatchObject({ code: "42501" });
  });
  it("customers cannot submit observations/evidence through the issuer or execute the fixed gateway", async () => {
    const w = await f.start(OWNER_A), row = await f.executeLogo(OWNER_A, "asset_prepare", w.projectId, write()) as { id: string };
    await expect(f.issueLogo(OWNER_A, "observe", w.projectId, { id: row.id, contentHash: hash })).rejects.toMatchObject({ code: "22023" });
    await expect(f.issueLogo(OWNER_A, "asset_readback", w.projectId, { id: row.id, contentHash: hash })).rejects.toMatchObject({ code: "22023" });
    const cap = await f.issueLogo(OWNER_A, "asset_readback", w.projectId, row.id);
    await expect(f.asAuth(OWNER_A, () => f.db.query("select public.execute_shared_logo_request($1,'asset_readback',$2::jsonb,'{}')", [cap.token, JSON.stringify([w.projectId, row.id])]))).rejects.toMatchObject({ code: "42501" });
    await expect(f.executeLogo(OWNER_A, "asset_readback", w.projectId, row.id, { status: "verified", checkedAt: new Date().toISOString(), contentHash: "a".repeat(64), mimeType: "image/png", byteLength: png.length })).rejects.toMatchObject({ code: "22023" });
  });
  it("normal composed input/store path uploads, validates actual PNG readback and replays reference registration for two owners", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fricsfwqibyhemknqgyf.supabase.co"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_inertfixture");
    const runtime = f.runtime();
    try {
      for (const owner of [OWNER_A, OWNER_B]) {
        const workspace = await f.start(owner), auth = f.auth(owner), resolved = await runtime.resolve(auth, workspace.projectId);
        expect(resolved?.ownerId).toBe(owner); const services = createLogoServices(resolved!.dependencies);
        const metadata = { requestKey: randomUUID(), expected: workspace.heads, aspects: ["shape"], rightsDeclaration: "My original fixture" };
        const registered = await services.inputs.uploadLogoReference(auth, workspace.projectId, metadata, png, "image/png");
        expect(registered.asset.ownerId).toBe(owner); expect(registered.asset.contentHash).toBe(hash);
        const calls = f.calls.length;
        expect(await services.inputs.uploadLogoReference(auth, workspace.projectId, metadata, png, "image/png")).toEqual(registered);
        expect(f.calls.length).toBe(calls);
        const bytes = await services.assets.readOwnedAsset(auth, registered.asset); expect(bytes.bytes).toEqual(png);
      }
      await f.db.exec("set session authorization postgres");
      expect((await f.db.query("select count(*)::int count from fluid_private.shared_logo_http_contexts")).rows).toEqual([{ count: 0 }]);
    } finally { await runtime.close(); vi.unstubAllEnvs(); }
  });

  it("normal composed vector acceptance verifies actual files/geometry and commits/replays two tenants on one fixed login", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fricsfwqibyhemknqgyf.supabase.co"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_inertfixture");
    const runtime = f.runtime();
    try {
      for (const owner of [OWNER_A, OWNER_B]) {
        const workspace = await f.start(owner), vector = await f.seedVector(owner, workspace.projectId), auth = f.auth(owner);
        const resolved = await runtime.resolve(auth, workspace.projectId), services = createLogoServices(resolved!.dependencies);
        const input = { requestKey: randomUUID(), expected: workspace.heads, vectorRevisionId: vector.id, acceptEarlierBasis: false };
        const accepted = await services.workspace.acceptLogoVector(auth, workspace.projectId, input);
        expect(accepted.ownerId).toBe(owner); expect(accepted.workspace.approvedLogo?.vectorRevisionId).toBe(vector.id);
        const calls = f.calls.length;
        expect(await services.workspace.acceptLogoVector(auth, workspace.projectId, input)).toEqual(accepted);
        expect(f.calls.length).toBe(calls);
        await f.db.exec("set session authorization postgres");
        expect((await f.db.query("select count(*)::int count from public.logo_approvals where project_id=$1", [workspace.projectId])).rows).toEqual([{ count: 1 }]);
      }
    } finally { await runtime.close(); vi.unstubAllEnvs(); }
  });

  it("lost actual Logo COMMIT ACK stays uncertain and original immutable intent recovers without repeating producer work", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fricsfwqibyhemknqgyf.supabase.co"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_inertfixture");
    const workspace = await f.start(OWNER_A), vector = await f.seedVector(OWNER_A, workspace.projectId), auth = f.auth(OWNER_A), runtime = f.runtime(true);
    const input = { requestKey: randomUUID(), expected: workspace.heads, vectorRevisionId: vector.id, acceptEarlierBasis: false };
    try {
      const resolved = await runtime.resolve(auth, workspace.projectId), services = createLogoServices(resolved!.dependencies);
      await expect(services.workspace.acceptLogoVector(auth, workspace.projectId, input)).rejects.toMatchObject({ name: "LogoUncertainCommitError", recovery: { projectId: workspace.projectId, input: { method: "acceptLogoVector", body: input } } });
      await f.db.exec("set session authorization postgres");
      expect((await f.db.query("select count(*)::int count from public.logo_approvals where project_id=$1", [workspace.projectId])).rows).toEqual([{ count: 1 }]);
    } finally { await runtime.close(); }
    const recovery = f.runtime();
    try {
      const resolved = await recovery.resolve(auth, workspace.projectId), services = createLogoServices(resolved!.dependencies), calls = f.calls.length;
      const accepted = await services.workspace.acceptLogoVector(auth, workspace.projectId, input);
      expect(accepted.workspace.approvedLogo?.vectorRevisionId).toBe(vector.id); expect(f.calls.length).toBe(calls);
    } finally { await recovery.close(); vi.unstubAllEnvs(); }
  });

  it("epoch, fixed-role extra EXEC and purpose mismatches fail closed", async () => {
    const workspace = await f.start(OWNER_A), intent = write(), cap = await f.issueLogo(OWNER_A, "asset_prepare", workspace.projectId, intent);
    await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1", [OWNER_A]);
    await f.db.query("update auth.users set banned_until=null where id=$1", [OWNER_A]);
    await expect(f.asSession(sharedLogoRole, () => f.db.query("select public.execute_shared_logo_request($1,'asset_prepare',$2::jsonb,null)", [cap.token, JSON.stringify([workspace.projectId, intent])]))).rejects.toMatchObject({ code: "42501" });
    const fresh = await f.issueLogo(OWNER_A, "asset_prepare", workspace.projectId, intent);
    await expect(f.asSession(sharedLogoRole, () => f.db.query("select public.execute_shared_logo_request($1,'input_prepare',$2::jsonb,null)", [fresh.token, JSON.stringify([workspace.projectId, intent])]))).rejects.toMatchObject({ code: "42501" });
    await f.db.exec("begin");
    try {
      await f.db.exec(`grant execute on function public.create_project(text,text,jsonb,text) to ${sharedLogoRole}`);
      await expect(f.asSession(sharedLogoRole, () => f.db.query("select public.shared_logo_http_principal()"))).rejects.toMatchObject({ code: "42501" });
    } finally { await f.db.exec("rollback"); }
    await f.db.exec("begin");
    try {
      await f.db.exec(`grant usage on schema fluid_private to ${sharedLogoRole}`);
      await expect(f.asSession(sharedLogoRole, () => f.db.query("select public.shared_logo_http_principal()"))).rejects.toMatchObject({ code: "42501" });
    } finally { await f.db.exec("rollback"); }
  });
  it.each([
    "drop policy embel_shared_legacy_storage_registry_fence on storage.objects",
    "alter policy embel_shared_legacy_storage_registry_fence on storage.objects using(true) with check(true)",
    "alter policy embel_shared_legacy_storage_registry_fence on storage.objects to authenticated,service_role",
  ])("rejects unsafe legacy Storage policy before proof RPC or HTTP IO: %s", async change => {
    const workspace = await f.start(OWNER_A), runtime = f.runtime(), before = f.calls.length;
    await f.db.exec("begin"); await f.db.exec(change); const queries = vi.spyOn(f.db, "query");
    try {
      await expect(runtime.resolve(f.auth(OWNER_A), workspace.projectId)).rejects.toMatchObject({ code: "integration_unavailable" });
      expect(f.calls.length).toBe(before);
      expect(queries.mock.calls.some(call => String(call[0]).includes("SELECT public.shared_logo_http_principal()"))).toBe(false);
    } finally { queries.mockRestore(); await runtime.close(); await f.db.exec("set session authorization postgres;rollback"); }
  });
});
