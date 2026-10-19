import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createTestDatabase, resetFixture, OWNER_B, type TestDatabase } from "./local-supabase";
import { generativeStorageFixture, installGenerativeStorageFixture, authUser } from "./logo-generative-storage-fixture";

describe("authenticated download metadata uses the exact generative object grant", () => {
  let db: TestDatabase, f: Awaited<ReturnType<typeof generativeStorageFixture>>;
  beforeAll(async () => {
    db = await createTestDatabase(); await installGenerativeStorageFixture(db);
    await db.exec(await readFile(new URL("../../supabase/activation/logo_concepts_40_download_metadata.sql", import.meta.url), "utf8"));
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); f = await generativeStorageFixture(db); });
  it("permits info and download only for the granted object while preserving operation and session fences", async () => {
    const { job } = await f.prepareConcept(0), { reservation } = await f.reserve(job);
    await f.enable();
    expect(await f.read(reservation, "object.get_authenticated_info")).toEqual([]);
    await f.authorize(job, reservation, "write"); await f.insert(reservation);
    for (const op of ["object.get_authenticated", "object.get_authenticated_info"]) expect(await f.read(reservation, op)).toHaveLength(1);
    for (const op of ["", "object.list", "object.list_v2", "object.sign", "object.get_authenticated_info.extra", "object.update", "object.delete"])
      expect(await f.read(reservation, op)).toEqual([]);
    expect(await f.read(reservation, "object.get_authenticated_info", {}, OWNER_B)).toEqual([]);
    const otherSession = randomUUID(); await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [otherSession, authUser]);
    expect(await f.read(reservation, "object.get_authenticated_info", { session_id: otherSession })).toEqual([]);
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    expect(await f.read(reservation, "object.get_authenticated_info")).toEqual([]);
  });
});
