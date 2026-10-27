import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedAccountFixture, type SharedAccountFixture } from "../database/shared-account-fixture";
import { HASH, OWNER_A, OWNER_B } from "../database/local-supabase";

// Real storage.objects policies and restricted authenticator/SET ROLE execution.
// JWT verification and physical objects are synthetic; this is no live Auth or
// Storage acceptance claim. Never call the web gateway to authorize raw access.
describe("raw customer Storage RLS under stale shared-account JWTs", () => {
  let fixture: SharedAccountFixture;
  beforeAll(async () => { fixture = await createSharedAccountFixture(); }, 90_000);
  afterAll(async () => { await fixture?.db.close(); });
  beforeEach(async () => { await fixture.db.exec("begin"); });
  afterEach(async () => { await fixture.db.exec("rollback; set session authorization postgres"); });

  async function attachment() {
    const id = randomUUID(), version = randomUUID();
    await fixture.db.query(`insert into public.home_attachments(id,owner_id,request_key,input,blob_version_id,name,mime_type,content_hash,byte_length,verified)
      values($1,$2,$3,'{}',$4,'review.txt','text/plain',$5,12,false)`, [id, OWNER_A, randomUUID(), version, HASH]);
    return `${OWNER_A}/home/${id}/${version}`;
  }
  async function raw<T>(operation: string, owner: string, run: () => Promise<T>, claims: Record<string, unknown> = {}) {
    await fixture.db.query("select set_config('storage.operation',$1,false)", [operation]);
    return fixture.asAuth(owner, run, claims);
  }
  const put = (path: string, claims: Record<string, unknown> = {}) => raw("object.upload", OWNER_A,
    () => fixture.db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, OWNER_A]), claims);
  const get = (path: string, owner = OWNER_A, claims: Record<string, unknown> = {}) => raw("object.get_authenticated", owner,
    async () => (await fixture.db.query("select name from storage.objects where bucket_id='fluid-assets' and name=$1", [path])).rows, claims);

  it("denies raw read and first upload immediately after ban despite an unexpired JWT", async () => {
    const old = await attachment(), pending = await attachment();
    await put(old); expect(await get(old)).toEqual([{ name: old }]);
    await fixture.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [OWNER_A]);
    expect(await get(old)).toEqual([]);
    await expect(put(pending)).rejects.toMatchObject({ code: "42501" });
  });

  it("denies deleted and expired physical sessions without relying on web RPC validation", async () => {
    const old = await attachment(), pending = await attachment(); await put(old);
    await fixture.db.query("update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1", [fixture.sessions[OWNER_A]]);
    expect(await get(old)).toEqual([]); await expect(put(pending)).rejects.toMatchObject({ code: "42501" });
    await fixture.db.query("delete from auth.sessions where id=$1", [fixture.sessions[OWNER_A]]);
    expect(await get(old)).toEqual([]); await expect(put(pending)).rejects.toMatchObject({ code: "42501" });
  });

  it("denies direct account disable independently of the Auth user's unchanged session", async () => {
    const old = await attachment(), pending = await attachment(); await put(old);
    await fixture.db.query("update fluid_private.shared_accounts set enabled=false where owner_id=$1", [OWNER_A]);
    expect(await get(old)).toEqual([]); await expect(put(pending)).rejects.toMatchObject({ code: "42501" });
  });

  it("preserves original immutable objects after unban and a fresh session while denying foreign access", async () => {
    const path = await attachment(); await put(path);
    await fixture.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [OWNER_A]);
    await fixture.db.query("update auth.users set banned_until=null where id=$1", [OWNER_A]);
    await fixture.db.query("delete from auth.sessions where id=$1", [fixture.sessions[OWNER_A]]);
    const fresh = randomUUID(); await fixture.db.query("insert into auth.sessions(id,user_id) values($1,$2)", [fresh, OWNER_A]);
    expect(await get(path, OWNER_A, { session_id: fresh })).toEqual([{ name: path }]);
    expect(await get(path, OWNER_B)).toEqual([]);
    await expect(put(path, { session_id: fresh })).rejects.toMatchObject({ code: "23505" });
    expect((await raw("object.update", OWNER_A, () => fixture.db.query("update storage.objects set name=name returning name"), { session_id: fresh })).rows).toEqual([]);
    expect((await raw("object.delete", OWNER_A, () => fixture.db.query("delete from storage.objects returning name"), { session_id: fresh })).rows).toEqual([]);
  });

  it.each([{ session_id: randomUUID() }, { exp: 1 }, { iss: "https://foreign.invalid/auth/v1" }, { is_anonymous: true }, { session_id: null }])(
    "fails raw access closed for invalid customer proof %j", async claims => {
      const path = await attachment(), pending = await attachment(); await put(path);
      expect(await get(path, OWNER_A, claims)).toEqual([]);
      await expect(put(pending, claims)).rejects.toMatchObject({ code: "42501" });
    },
  );
});
