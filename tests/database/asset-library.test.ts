import {
  assetLibraryPageSchema,
  assetDetailSchema,
  assetRetentionResponseSchema,
  assetSelectionResponseSchema,
} from "../../src/domain/asset-library";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, HASH, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";
import { createAssetLibraryTestDatabase, seedLibraryAsset, seedLibraryVersion } from "./asset-library-fixture";

// Local metadata fixtures only. No live Storage, provider or remote DB access.
describe("authoritative Assets database permissions", () => {
  let db: TestDatabase;
  let projectId: string;
  let assetId: string;
  let versionId: string;
  beforeAll(async () => {
    db = await createAssetLibraryTestDatabase();
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await resetFixture(db);
    projectId = (await seedProject(db)).id;
    assetId = await seedLibraryAsset(db, projectId);
    versionId = await seedLibraryVersion(db, projectId, assetId);
  });
  const owner = <T>(run: () => Promise<T>) => asRole(db, "authenticated", OWNER_A, run);

  it.each(["liked", "saved", "used"] as const)(
    "denies an owned direct %s update that would bypass authoritative revisions",
    async (column) => {
      await expect(
        owner(() => db.query(`update public.assets set ${column}=true where id=$1`, [assetId])),
      ).rejects.toMatchObject({ code: "42501" });
    },
  );
  it("denies owned free-form selection inserts outside the expected-revision RPC", async () => {
    await expect(
      owner(() =>
        db.query(
          "insert into public.asset_selections(project_id,asset_id,version_id,reason) values($1,$2,$3,'selected')",
          [projectId, assetId, versionId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("keeps immutable version bytes and metadata outside authenticated write authority", async () => {
    const before = (await db.query("select to_jsonb(v) row from public.asset_versions v where id=$1", [versionId]))
      .rows;
    await expect(
      owner(() => db.query("update public.asset_versions set provenance='{}' where id=$1", [versionId])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.query("update public.asset_versions set content='{}' where id=$1", [versionId]),
    ).rejects.toMatchObject({ code: "55000" });
    expect(
      (await db.query("select to_jsonb(v) row from public.asset_versions v where id=$1", [versionId])).rows,
    ).toEqual(before);
  });
});

describe("owned asset library and immutable selections", () => {
  let db: TestDatabase;
  let projectId: string;
  beforeAll(async () => {
    db = await createAssetLibraryTestDatabase();
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await resetFixture(db);
    projectId = (await seedProject(db)).id;
  });
  async function rpc(name: string, args: unknown[] = [], ownerId = OWNER_A) {
    return asRole(
      db,
      "authenticated",
      ownerId,
      async () =>
        (
          await db.query<{ result: unknown }>(
            `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) result`,
            args.map((value) => (value && typeof value === "object" ? JSON.stringify(value) : value)),
          )
        ).rows[0]!.result,
    );
  }
  const list = async (query: unknown = {}, ownerId = OWNER_A) =>
    assetLibraryPageSchema.parse(await rpc("list_account_assets", [query], ownerId));
  const detail = async (assetId: string, query: unknown = {}, ownerId = OWNER_A) =>
    assetDetailSchema.parse(await rpc("get_asset_detail", [assetId, query], ownerId));

  it("canonicalizes direct RPC query UUIDs before filter echoes and cursor binding", async () => {
    const older = await seedLibraryAsset(db, projectId, { liked: true, createdAt: "2026-10-01T00:00:00Z" });
    const newer = await seedLibraryAsset(db, projectId, { liked: true });
    await seedLibraryVersion(db, projectId, newer);
    await seedLibraryVersion(db, projectId, newer, { version: 2, createdAt: "2026-10-01T00:00:00Z" });
    const first = await list({ projectId: projectId.toUpperCase(), limit: 1 });
    expect(first.query.projectId).toBe(projectId);
    const cursor = first.nextCursor!;
    const next = await list({
      projectId: projectId.toUpperCase(),
      limit: 1,
      cursor: { ...cursor, assetId: cursor.assetId.toUpperCase() },
    });
    expect(next.items.map((item) => item.asset.id)).toEqual([older]);
    expect(next.query.cursor?.assetId).toBe(newer);
    const versions = (await detail(newer.toUpperCase(), { limit: 1 })).versions;
    const versionCursor = versions.nextCursor!;
    const following = await detail(newer.toUpperCase(), {
      limit: 1,
      cursor: {
        ...versionCursor,
        assetId: newer.toUpperCase(),
        projectId: projectId.toUpperCase(),
        versionId: versionCursor.versionId.toUpperCase(),
      },
    });
    expect(following.versions.items).toHaveLength(1);
    expect(following.versions.items[0]!.versionId).not.toBe(versionCursor.versionId);
  });

  it("deduplicates retention flags, keeps all generations and preserves zero-version/unknown metadata rows", async () => {
    const retained = await seedLibraryAsset(db, projectId, { liked: true, saved: true });
    const loose = await seedLibraryAsset(db, projectId);
    const zero = await seedLibraryAsset(db, projectId);
    await seedLibraryVersion(db, projectId, retained, {
      mimeType: "application/x-unrecognized",
      provenance: {
        source: "provider_generation",
        provider: "fixture-claim",
        vectorStatus: "validated_paths",
        credential: "must-not-be-exported",
      },
    });
    await seedLibraryVersion(db, projectId, loose, { stored: true });
    const selected = await list();
    expect(selected.items.map((row) => row.asset.id)).toEqual([retained]);
    expect(selected.items[0]!.displayedVersion).toMatchObject({
      format: "other",
      fileState: "metadata_only",
      provenance: { status: "legacy_unverified" },
      vectorStatus: "unverified",
      licenseStatus: "unverified",
    });
    expect(JSON.stringify(selected)).not.toContain("must-not-be-exported");
    expect(JSON.stringify(selected)).not.toContain("storage_path");
    const all = await list({ tab: "all_generations" });
    expect(new Set(all.items.map((row) => row.asset.id))).toEqual(new Set([retained, loose, zero]));
    expect(all.items.find((row) => row.asset.id === zero)).toMatchObject({
      asset: { versionCount: 0, currentSelection: null, selectionRevision: 0 },
      selectedVersion: null,
      displayedVersion: null,
      matchingVersions: { items: [], totalCount: 0, nextCursor: null },
    });
    expect(all.items.find((row) => row.asset.id === loose)!.displayedVersion!.fileState).toBe("unverified");
  });
  it.each([
    [" ASCII ", " IMAGE/PNG; charset=binary", "png"],
    ["tab", "\timage/png\t; charset=binary", "png"],
    ["NBSP", "\u00a0image/png\u00a0", "png"],
    ["BOM", "\ufeffimage/png\ufeff", "png"],
    [
      "all ECMAScript whitespace",
      "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeffAPPLICATION/JSON\ufeff\u3000\u205f\u202f\u2029\u2028\u200a\u2009\u2008\u2007\u2006\u2005\u2004\u2003\u2002\u2001\u2000\u1680\u00a0\u0020\u000d\u000c\u000b\u000a\u0009",
      "json",
    ],
    ["dotted I lookalike", "\u0130mage/png", "other"],
    ["non-ECMAScript NEL", "\u0085image/png\u0085", "other"],
    ["zero width space", "\u200bimage/png\u200b", "other"],
  ] as const)(
    "matches the public MIME contract for %s without locale-dependent folding",
    async (_label, mime, format) => {
      const asset = await seedLibraryAsset(db, projectId, { liked: true });
      await seedLibraryVersion(db, projectId, asset, { mimeType: mime });
      const unfiltered = await list();
      expect(unfiltered.items[0]!.displayedVersion).toMatchObject({ mimeType: mime, format });
      expect((await list({ format })).items.map((row) => row.asset.id)).toEqual([asset]);
    },
  );
  it("filters only explicit reference media and never guesses from legacy kind labels", async () => {
    const unknown = await seedLibraryAsset(db, projectId, { kind: "reference_media", liked: true });
    const reference = await seedLibraryAsset(db, projectId, { liked: true, purpose: "reference_media" });
    expect((await list()).items.map((row) => row.asset.id)).toEqual([unknown]);
    await expect(detail(reference)).rejects.toMatchObject({ code: "P0002" });
    await expect(rpc("set_asset_retention", [reference, 0, true, true])).rejects.toMatchObject({ code: "P0002" });
  });
  it("preserves purpose immutably even across privileged internal updates", async () => {
    const asset = await seedLibraryAsset(db, projectId, { kind: "legacy reference label" });
    await expect(
      db.query("update public.assets set purpose='reference_media' where id=$1", [asset]),
    ).rejects.toMatchObject({ code: "55000" });
    expect((await db.query("select purpose from public.assets where id=$1", [asset])).rows).toEqual([
      { purpose: "legacy_unknown" },
    ]);
  });
  it("checks project ownership, cursor ownership and same-owner cross-project selection boundaries", async () => {
    const own = await seedLibraryAsset(db, projectId, { liked: true });
    const ownVersion = await seedLibraryVersion(db, projectId, own);
    const otherProject = (await seedProject(db, OWNER_B)).id;
    const foreign = await seedLibraryAsset(db, otherProject, { ownerId: OWNER_B, liked: true });
    await seedLibraryVersion(db, otherProject, foreign, { ownerId: OWNER_B });
    expect((await list()).items.map((row) => row.asset.id)).toEqual([own]);
    expect((await list({}, OWNER_B)).items.map((row) => row.asset.id)).toEqual([foreign]);
    await expect(detail(own, {}, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(list({ projectId: otherProject })).rejects.toMatchObject({ code: "P0002" });
    const sameOwnerProject = (await seedProject(db)).id;
    const otherAsset = await seedLibraryAsset(db, sameOwnerProject);
    const otherVersion = await seedLibraryVersion(db, sameOwnerProject, otherAsset);
    await expect(rpc("select_asset_version", [own, otherVersion, 1, 0, false])).rejects.toMatchObject({
      code: "P0002",
    });
    await expect(rpc("select_asset_version", [foreign, ownVersion, 1, 0, false], OWNER_B)).rejects.toMatchObject({
      code: "P0002",
    });
    expect((await db.query("select * from public.asset_selections")).rows).toEqual([]);
  });
  it("applies populated tenant RLS to both heads and receipts and denies anonymous reads", async () => {
    const own = await seedLibraryAsset(db, projectId);
    const ownVersion = await seedLibraryVersion(db, projectId, own);
    await rpc("select_asset_version", [own, ownVersion, 1, 0, false]);
    const otherProject = (await seedProject(db, OWNER_B)).id;
    const foreign = await seedLibraryAsset(db, otherProject, { ownerId: OWNER_B });
    const foreignVersion = await seedLibraryVersion(db, otherProject, foreign, { ownerId: OWNER_B });
    await rpc("select_asset_version", [foreign, foreignVersion, 1, 0, false], OWNER_B);
    for (const table of ["asset_heads", "asset_selection_receipts"]) {
      expect((await db.query(`select * from public.${table}`)).rows).toHaveLength(2);
      const rows = await asRole(db, "authenticated", OWNER_A, () =>
        db.query<{ owner_id: string; asset_id: string }>(`select owner_id,asset_id from public.${table}`),
      );
      expect(rows.rows).toEqual([{ owner_id: OWNER_A, asset_id: own }]);
      expect(
        (
          await asRole(db, "authenticated", OWNER_B, () =>
            db.query<{ owner_id: string; asset_id: string }>(`select owner_id,asset_id from public.${table}`),
          )
        ).rows,
      ).toEqual([{ owner_id: OWNER_B, asset_id: foreign }]);
      await expect(asRole(db, "anon", null, () => db.query(`select * from public.${table}`))).rejects.toMatchObject({
        code: "42501",
      });
    }
  });
  it("advances retention independently and rejects stale writes without deleting generations", async () => {
    const asset = await seedLibraryAsset(db, projectId);
    const version = await seedLibraryVersion(db, projectId, asset);
    const first = assetRetentionResponseSchema.parse(await rpc("set_asset_retention", [asset, 0, true, true]));
    expect(first.asset).toMatchObject({
      retentionRevision: 1,
      liked: true,
      saved: true,
      selectionRevision: 0,
      usage: { active: false, legacy: false },
    });
    await expect(rpc("set_asset_retention", [asset, 0, false, false])).rejects.toMatchObject({ code: "PT409" });
    await rpc("set_asset_retention", [asset, 1, false, false]);
    expect((await list()).items).toEqual([]);
    expect((await list({ tab: "all_generations" })).items[0]!.displayedVersion!.versionId).toBe(version);
  });
  it("separates selected version from matching preview and exposes every version through bounded cursors", async () => {
    const asset = await seedLibraryAsset(db, projectId, { liked: true });
    const ids: string[] = [];
    for (let index = 1; index <= 7; index++)
      ids.push(
        await seedLibraryVersion(db, projectId, asset, {
          version: index,
          mimeType: index === 1 ? "image/png" : " image/svg+xml ; charset=utf-8",
          createdAt: `2026-10-01T12:00:0${index}Z`,
        }),
      );
    await rpc("select_asset_version", [asset, ids[0], 1, 0, false]);
    const plain = (await list()).items[0]!;
    expect(plain.displayedVersion!.versionId).toBe(ids[0]);
    expect(plain.matchingVersions.items.map((row) => row.versionId)).not.toContain(ids[0]);
    const filtered = (await list({ format: "svg" })).items[0]!;
    expect(filtered.selectedVersion!.versionId).toBe(ids[0]);
    expect(filtered.displayedVersion!.versionId).toBe(ids[6]);
    expect(filtered.matchingVersions.items).toHaveLength(4);
    expect(filtered.matchingVersions.totalCount).toBe(6);
    const rest = await detail(asset, { format: "svg", cursor: filtered.matchingVersions.nextCursor });
    expect(rest.versions.items).toHaveLength(2);
    expect(rest.versions.nextCursor).toBeNull();
    const full = await detail(asset, { limit: 2 });
    const next = await detail(asset, { limit: 100, cursor: full.versions.nextCursor });
    expect([...full.versions.items, ...next.versions.items].map((row) => row.versionId)).toEqual([...ids].reverse());
    await expect(detail(asset, { format: "png", cursor: filtered.matchingVersions.nextCursor })).rejects.toMatchObject({
      code: "22023",
    });
  });
  it("uses stable query-bound library cursors even after the cursor asset leaves retained membership", async () => {
    const ids: string[] = [];
    for (let index = 1; index <= 3; index++)
      ids.push(await seedLibraryAsset(db, projectId, { liked: true, createdAt: `2026-10-01T10:00:0${index}Z` }));
    const first = await list({ limit: 1 });
    expect(first.items[0]!.asset.id).toBe(ids[2]);
    await rpc("set_asset_retention", [ids[2], 0, false, false]);
    const second = await list({ limit: 1, cursor: first.nextCursor });
    expect(second.items[0]!.asset.id).toBe(ids[1]);
    await expect(list({ tab: "all_generations", cursor: first.nextCursor })).rejects.toMatchObject({ code: "22023" });
    const otherProject = (await seedProject(db, OWNER_B)).id;
    const foreign = await seedLibraryAsset(db, otherProject, { ownerId: OWNER_B, liked: true });
    await expect(list({ cursor: { ...first.nextCursor, assetId: foreign } })).rejects.toMatchObject({ code: "P0002" });
  });
  it("binds stale restoration acknowledgement to the current saved project and appends immutable receipts", async () => {
    const asset = await seedLibraryAsset(db, projectId);
    const first = await seedLibraryVersion(db, projectId, asset);
    await rpc("append_project_revision", [projectId, 1, { description: "A later saved local fixture" }, HASH]);
    const second = await seedLibraryVersion(db, projectId, asset, { version: 2, inputRevision: 2 });
    await expect(rpc("select_asset_version", [asset, first, 2, 0, false])).rejects.toMatchObject({ code: "PT409" });
    await expect(rpc("select_asset_version", [asset, first, 1, 0, true])).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select * from public.asset_selections")).rows).toEqual([]);
    const selected = assetSelectionResponseSchema.parse(await rpc("select_asset_version", [asset, first, 2, 0, true]));
    expect(selected.asset.currentSelection!.receipt).toEqual({
      status: "recorded",
      projectRevision: 2,
      acceptedStaleBasis: true,
      previousSelectionId: null,
    });
    expect(selected.asset.usage).toEqual({ active: false, legacy: false });
    await expect(rpc("select_asset_version", [asset, second, 2, 0, false])).rejects.toMatchObject({ code: "PT409" });
    const next = assetSelectionResponseSchema.parse(await rpc("select_asset_version", [asset, second, 2, 1, false]));
    expect(next.asset.currentSelection!.receipt).toMatchObject({
      previousSelectionId: selected.asset.currentSelection!.id,
      acceptedStaleBasis: false,
    });
    expect(next.asset.selectionRevision).toBe(2);
    const restored = assetSelectionResponseSchema.parse(await rpc("select_asset_version", [asset, first, 2, 2, true]));
    expect(restored.asset.currentSelection!.reason).toBe("restored");
    expect((await db.query("select count(*)::integer n from public.asset_selections")).rows).toEqual([{ n: 3 }]);
    await expect(
      db.query("update public.asset_selection_receipts set accepted_stale_basis=false"),
    ).rejects.toMatchObject({ code: "55000" });
  });
  it("enforces joint head event/version and owned receipt links in SQL", async () => {
    const asset = await seedLibraryAsset(db, projectId);
    const first = await seedLibraryVersion(db, projectId, asset);
    const second = await seedLibraryVersion(db, projectId, asset, { version: 2 });
    const selected = assetSelectionResponseSchema.parse(await rpc("select_asset_version", [asset, first, 1, 0, false]));
    await expect(
      db.query("update public.asset_heads set current_version_id=$1 where asset_id=$2", [second, asset]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      asRole(db, "authenticated", OWNER_A, () =>
        db.query("update public.assets set purpose='brand_asset',legacy_used=true where id=$1", [asset]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole(db, "authenticated", OWNER_A, () =>
        db.query("update public.asset_heads set selection_revision=8 where asset_id=$1", [asset]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole(db, "authenticated", OWNER_A, () =>
        db.query(
          "insert into public.asset_selection_receipts(selection_id,asset_id,project_id,owner_id,version_id,project_revision,accepted_stale_basis) values($1,$2,$3,$4,$5,1,false)",
          [selected.asset.currentSelection!.id, asset, projectId, OWNER_A, first],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
