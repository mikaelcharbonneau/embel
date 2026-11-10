import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getIdentityReferences, setReferenceReaction } from "../../src/server/data/identity-references";
import { asRole, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";
import {
  createReferenceTestDatabase,
  seedReference,
  readReferences,
  react,
  capture,
  referenceDalAuth,
} from "./identity-reference-database";
import { identityReferenceBasis } from "../../src/domain/identity-references";
let db: TestDatabase, project: string, otherProject: string, foreignProject: string;
const tables = [
  "identity_reference_heads",
  "identity_references",
  "identity_reference_reactions",
  "identity_reference_snapshots",
];
beforeAll(async () => {
  db = await createReferenceTestDatabase();
}, 30_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await resetFixture(db);
  project = (await seedProject(db)).id;
  otherProject = (await seedProject(db)).id;
  foreignProject = (await seedProject(db, OWNER_B)).id;
});

describe("reference ownership, capabilities and durable media binding", () => {
  it("reads a real empty unconfigured state without creating a head, selection, snapshot or job", async () => {
    expect(await readReferences(db, project)).toEqual({
      ownerId: OWNER_A,
      projectId: project,
      query: { limit: 40, excludedTags: [] },
      referenceRevision: 0,
      selectedReferenceCount: 0,
      feed: { status: "unavailable", reason: "reference_source_unconfigured" },
      availableTags: [],
      tagsComplete: true,
      references: { items: [], nextCursor: null },
    });
    for (const table of [...tables, "jobs"])
      expect(
        (await db.query<{ count: number }>(`select count(*)::int count from public.${table}`)).rows[0]!.count,
      ).toBe(0);
  });
  it("hides another owner at both RPC and direct RLS boundaries", async () => {
    const own = await seedReference(db, project),
      foreign = await seedReference(db, foreignProject, { ownerId: OWNER_B });
    await react(db, project, own.reference);
    await react(db, foreignProject, foreign.reference, undefined, OWNER_B);
    await capture(db, project, 1);
    await capture(db, foreignProject, 1, OWNER_B);
    await expect(readReferences(db, foreignProject)).rejects.toMatchObject({ code: "P0002" });
    await expect(react(db, foreignProject, foreign.reference)).rejects.toMatchObject({ code: "P0002" });
    await asRole(db, "authenticated", OWNER_A, async () => {
      for (const table of tables)
        expect(
          (await db.query<{ owner_id: string }>(`select owner_id from public.${table}`)).rows.map(
            (row) => row.owner_id,
          ),
        ).toEqual([OWNER_A]);
    });
    const security = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity,relforcerowsecurity from pg_class where relname=any($1::text[])",
      [tables],
    );
    expect(security.rows).toHaveLength(4);
    expect(security.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
  it("rejects direct client writes, anonymous calls and new service capabilities", async () => {
    await asRole(db, "authenticated", OWNER_A, async () => {
      for (const table of tables)
        for (const command of ["insert into", "update", "delete from"]) {
          const sql =
            command === "insert into"
              ? `insert into public.${table}(owner_id,project_id) values($1,$2)`
              : command === "update"
                ? `update public.${table} set owner_id=$1 where project_id=$2`
                : `delete from public.${table} where owner_id=$1 and project_id=$2`;
          await expect(db.query(sql, [OWNER_A, project])).rejects.toMatchObject({ code: "42501" });
        }
      await expect(
        db.query("select fluid_private.capture_identity_reference_snapshot($1,0)", [project]),
      ).rejects.toMatchObject({ code: "42501" });
    });
    for (const role of ["anon", "service_role"] as const)
      await asRole(db, role, OWNER_A, async () => {
        await expect(db.query("select public.get_identity_references($1,'{}')", [project])).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          db.query("select public.set_identity_reference_reaction($1,gen_random_uuid(),'{}')", [project]),
        ).rejects.toMatchObject({ code: "42501" });
      });
  });
  it.each([
    { purpose: "brand_asset" },
    { purpose: "legacy_unknown" },
    { mimeType: "image/svg+xml" },
    { mimeType: "text/html" },
    { stored: false },
  ])("rejects unusable reference media %j", async (options) => {
    await expect(seedReference(db, project, options)).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects foreign and same-owner cross-project media, references and reactions", async () => {
    await expect(seedReference(db, project, { mediaProjectId: otherProject })).rejects.toMatchObject({ code: "23514" });
    await expect(
      seedReference(db, project, { mediaProjectId: foreignProject, mediaOwnerId: OWNER_B }),
    ).rejects.toMatchObject({ code: "23514" });
    const own = await seedReference(db, project);
    await expect(react(db, otherProject, own.reference)).rejects.toMatchObject({ code: "P0002" });
    await expect(
      db.query(
        "insert into public.identity_reference_reactions(reference_id,project_id,owner_id,revision,ensemble,elements) values($1,$2,$3,1,true,'{}')",
        [own.reference, otherProject, OWNER_A],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it.each([
    { source: "fabricated_verified_catalog" },
    { attribution: { label: "Synthetic", creator: null, sourceUrl: null, rightsNote: null, licenseVerified: true } },
    { attribution: { label: "Synthetic", creator: null, sourceUrl: "javascript:alert(1)", rightsNote: null } },
    {
      attribution: {
        label: "Synthetic",
        creator: null,
        sourceUrl: "https://name:secret@example.invalid/file",
        rightsNote: null,
      },
    },
    { attribution: {} },
  ])("rejects unsupported source or attribution claims at insertion %j", async (options) => {
    await expect(seedReference(db, project, options)).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    { tags: ["duplicate", "duplicate"] },
    { tags: Array.from({ length: 51 }, (_, n) => `tag-${n}`) },
    { relevantElements: ["logo", "logo"] },
    { relevantElements: ["invented"] },
  ])("rejects malformed reference sets at insertion %j", async (options) => {
    await expect(seedReference(db, project, options)).rejects.toMatchObject({ code: "22023" });
  });
  it("allows an explicit Ensemble-only selection without creating element likes", async () => {
    const own = await seedReference(db, project, { relevantElements: [] });
    expect(
      (await react(db, project, own.reference, { expectedRevision: 0, ensemble: true, elements: [] })).entry.reaction,
    ).toMatchObject({ ensemble: true, elements: [] });
    await expect(
      react(db, project, own.reference, { expectedRevision: 1, ensemble: true, elements: ["logo"] }),
    ).rejects.toMatchObject({ code: "22023" });
  });
  it("preserves source/media/relevance and bound asset purpose after creation", async () => {
    const own = await seedReference(db, project);
    for (const statement of [
      "update public.identity_references set tags='{}'",
      "update public.identity_references set attribution='{}'",
      "delete from public.identity_references",
    ])
      await expect(db.exec(statement)).rejects.toMatchObject({ code: "55000" });
    await expect(
      db.query("update public.assets set purpose='brand_asset' where id=$1", [own.asset]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      db.query("update public.asset_versions set mime_type='text/html' where id=$1", [own.version]),
    ).rejects.toMatchObject({ code: "55000" });
  });
});

describe("independent reference reactions and bounded atomic revisions", () => {
  it("keeps Ensemble and multiple element likes independent without changing project/assets/jobs", async () => {
    const own = await seedReference(db, project);
    let receipt = await react(db, project, own.reference, {
      expectedRevision: 0,
      ensemble: false,
      elements: ["colors", "logo"],
    });
    expect(receipt.entry.reaction).toMatchObject({ revision: 1, ensemble: false, elements: ["logo", "colors"] });
    receipt = await react(db, project, own.reference, { expectedRevision: 1, ensemble: true, elements: ["colors"] });
    receipt = await react(db, project, own.reference, { expectedRevision: 2, ensemble: false, elements: ["colors"] });
    expect(receipt).toMatchObject({
      referenceRevision: 3,
      selectedReferenceCount: 1,
      entry: { reaction: { revision: 3, ensemble: false, elements: ["colors"] } },
    });
    receipt = await react(db, project, own.reference, { expectedRevision: 3, ensemble: false, elements: [] });
    expect(receipt.selectedReferenceCount).toBe(0);
    expect((await db.query("select current_revision from public.projects where id=$1", [project])).rows[0]).toEqual({
      current_revision: 1,
    });
    expect(
      (await db.query("select liked,saved,used,retention_revision from public.assets where id=$1", [own.asset]))
        .rows[0],
    ).toEqual({ liked: false, saved: false, used: false, retention_revision: 0 });
    expect((await db.query("select count(*)::int count from public.jobs")).rows[0]).toEqual({ count: 0 });
  });
  it.each([
    { expectedRevision: 0, ensemble: false, elements: ["logo", "logo"] },
    { expectedRevision: 0, ensemble: false, elements: ["unknown"] },
    { expectedRevision: 0, ensemble: false, elements: ["images"] },
    { expectedRevision: "0", ensemble: false, elements: [] },
    { expectedRevision: 0.5, ensemble: false, elements: [] },
    { expectedRevision: 0, ensemble: "true", elements: [] },
    { expectedRevision: 0, ensemble: false, elements: [], ownerId: OWNER_A },
    { expectedRevision: 0, ensemble: false, elements: [], media: {} },
    { expectedRevision: 0, ensemble: false },
    null,
    [],
  ])("rejects invalid mutation input without advancing state %j", async (input) => {
    const own = await seedReference(db, project);
    await expect(react(db, project, own.reference, input)).rejects.toMatchObject({ code: "22023" });
    expect((await readReferences(db, project)).referenceRevision).toBe(0);
  });
  it("accepts exactly one competing expected revision, including explicit no-op CAS writes", async () => {
    const own = await seedReference(db, project);
    await asRole(db, "authenticated", OWNER_A, async () => {
      const args = [project, own.reference, JSON.stringify({ expectedRevision: 0, ensemble: false, elements: [] })];
      const results = await Promise.allSettled([
        db.query("select public.set_identity_reference_reaction($1,$2,$3::jsonb)", args),
        db.query("select public.set_identity_reference_reaction($1,$2,$3::jsonb)", args),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "PT409" } });
    });
    expect(await readReferences(db, project)).toMatchObject({ referenceRevision: 1, selectedReferenceCount: 0 });
  });
  it("enforces 100 selected references without dropping a previous choice", async () => {
    const refs: Awaited<ReturnType<typeof seedReference>>[] = [];
    for (let i = 0; i < 101; i++) refs.push(await seedReference(db, project));
    for (const row of refs.slice(0, 100)) await react(db, project, row.reference);
    await expect(react(db, project, refs[100]!.reference)).rejects.toMatchObject({ code: "PT409" });
    expect(await readReferences(db, project)).toMatchObject({ referenceRevision: 100, selectedReferenceCount: 100 });
    expect((await capture(db, project, 100)).selected).toHaveLength(100);
    await react(db, project, refs[0]!.reference, { expectedRevision: 1, ensemble: false, elements: [] });
    expect((await react(db, project, refs[100]!.reference)).selectedReferenceCount).toBe(100);
  }, 20_000);
  it.each(["head", "reaction"])("fails closed when the %s counter is exhausted", async (kind) => {
    const own = await seedReference(db, project);
    await react(db, project, own.reference);
    if (kind === "head")
      await db.query(
        "update public.identity_reference_heads set reference_revision=9007199254740991 where project_id=$1",
        [project],
      );
    else
      await db.query("update public.identity_reference_reactions set revision=9007199254740991 where reference_id=$1", [
        own.reference,
      ]);
    await expect(
      react(db, project, own.reference, {
        expectedRevision: kind === "head" ? 1 : Number.MAX_SAFE_INTEGER,
        ensemble: false,
        elements: [],
      }),
    ).rejects.toMatchObject({ code: "PT409" });
    expect(
      (
        await db.query("select selected_reference_count from public.identity_reference_heads where project_id=$1", [
          project,
        ])
      ).rows[0],
    ).toEqual({ selected_reference_count: 1 });
  });
});

describe("project-bound filtered pages and honest bounded tag suggestions", () => {
  it("filters before limit, retains project counts and continues equal timestamps by immutable ID", async () => {
    const timestamp = "2026-10-04T10:00:00Z",
      refs = [];
    for (let i = 0; i < 4; i++)
      refs.push(await seedReference(db, project, { tags: [i === 0 ? "excluded" : "kept"], createdAt: timestamp }));
    await react(db, project, refs[0]!.reference);
    await react(db, project, refs[1]!.reference);
    const page = await readReferences(db, project, { limit: 2, excludedTags: ["excluded"] });
    expect(page.selectedReferenceCount).toBe(2);
    expect(page.references.items).toHaveLength(2);
    expect(page.references.items.map((item) => item.reference.id)).toEqual(
      refs
        .slice(1)
        .map((row) => row.reference)
        .sort()
        .reverse()
        .slice(0, 2),
    );
    const next = await readReferences(db, project, {
      limit: 2,
      excludedTags: ["excluded"],
      cursor: page.references.nextCursor,
    });
    expect(next.references.items).toHaveLength(1);
    expect(next.references.nextCursor).toBeNull();
    expect(new Set([...page.references.items, ...next.references.items].map((item) => item.reference.id)).size).toBe(3);
  });
  it("accepts actual exclusions beyond 50 suggestions, covers full page tags and marks incomplete metadata", async () => {
    for (let i = 0; i < 4; i++)
      await seedReference(db, project, {
        tags: Array.from({ length: 50 }, (_, n) => `tag-${i}-${String(n).padStart(2, "0")}`),
      });
    const page = await readReferences(db, project, { limit: 1 });
    expect(page.availableTags.length).toBeGreaterThan(50);
    expect(page.tagsComplete).toBe(false);
    expect(page.references.items[0]!.reference.tags.every((tag) => page.availableTags.includes(tag))).toBe(true);
    const filtered = await readReferences(db, project, { limit: 1, excludedTags: ["tag-2-49"] });
    expect(filtered.availableTags).toContain("tag-2-49");
    expect(filtered.references.items.every((item) => !item.reference.tags.includes("tag-2-49"))).toBe(true);
    const whole = await readReferences(db, project, { limit: 100 });
    expect(whole.tagsComplete).toBe(true);
    expect(whole.availableTags).toHaveLength(200);
    await expect(readReferences(db, project, { excludedTags: ["invented-style"] })).rejects.toMatchObject({
      code: "22023",
    });
  });
  it.each([
    null,
    [],
    { ownerId: OWNER_A },
    { limit: "1" },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { excludedTags: ["local-tag", "local-tag"] },
    { excludedTags: [2] },
    { cursor: {} },
  ])("rejects malformed or injected query %j", async (query) => {
    await seedReference(db, project);
    await expect(readReferences(db, project, query)).rejects.toMatchObject({ code: "22023" });
  });
  it("rejects changed filters, project, time and foreign/missing anchor continuations", async () => {
    await seedReference(db, project);
    await seedReference(db, project);
    const page = await readReferences(db, project, { limit: 1 }),
      cursor = page.references.nextCursor!;
    for (const patch of [
      { projectId: otherProject },
      { excludedTags: ["local-tag"] },
      { createdAt: "bad-time" },
      { createdAt: "2026-10-04T00:00:00Z" },
    ])
      await expect(readReferences(db, project, { limit: 1, cursor: { ...cursor, ...patch } })).rejects.toMatchObject({
        code: "22023",
      });
    const foreign = await seedReference(db, foreignProject, { ownerId: OWNER_B });
    await expect(
      readReferences(db, project, { limit: 1, cursor: { ...cursor, referenceId: foreign.reference } }),
    ).rejects.toMatchObject({ code: "P0002" });
  });
});

describe("complete immutable snapshot capture", () => {
  it("rejects missing or conflicting snapshot envelope ownership, including SQL CHECK nulls", async () => {
    for (const snapshot of [
      {},
      { version: 1, ownerId: OWNER_B, projectId: project, referenceRevision: 0 },
      { version: 1, ownerId: OWNER_A, referenceRevision: 0 },
    ]) {
      await expect(
        db.query(
          "insert into public.identity_reference_snapshots(project_id,owner_id,reference_revision,snapshot) values($1,$2,0,$3::jsonb)",
          [project, OWNER_A, JSON.stringify(snapshot)],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
  it("captures all selections across pages and exclusions, independent of generic asset state", async () => {
    const refs: Awaited<ReturnType<typeof seedReference>>[] = [];
    for (let i = 0; i < 3; i++) {
      const row = await seedReference(db, project, { tags: [i === 0 ? "excluded" : "kept"] });
      refs.push(row);
      await react(db, project, row.reference);
    }
    expect((await readReferences(db, project, { limit: 1, excludedTags: ["excluded"] })).references.items).toHaveLength(
      1,
    );
    const snap = await capture(db, project, 3);
    expect(snap.selectedReferenceCount).toBe(3);
    expect(snap.selected).toHaveLength(3);
    expect(await capture(db, project, 3)).toEqual(snap);
    await db.query("update public.assets set liked=true,saved=true where id=$1", [refs[0]!.asset]);
    expect(identityReferenceBasis(await capture(db, project, 3))).toEqual(identityReferenceBasis(snap));
    await react(db, project, refs[0]!.reference, { expectedRevision: 1, ensemble: true, elements: [] });
    await expect(capture(db, project, 3)).rejects.toMatchObject({ code: "PT409" });
    expect(
      (
        await db.query<{ snapshot: unknown }>(
          "select snapshot from public.identity_reference_snapshots where project_id=$1 and reference_revision=3",
          [project],
        )
      ).rows[0]!.snapshot,
    ).toEqual(snap);
    expect(
      (await capture(db, project, 4)).selected.find((row) => row.reference.id === refs[0]!.reference)!.reaction,
    ).toMatchObject({ ensemble: true, elements: [] });
    await expect(db.exec("update public.identity_reference_snapshots set snapshot='{}'")).rejects.toMatchObject({
      code: "55000",
    });
    await expect(db.exec("delete from public.identity_reference_snapshots")).rejects.toMatchObject({ code: "55000" });
  });
  it("rejects count corruption and another owner, and represents a genuine empty snapshot", async () => {
    expect(await capture(db, project, 0)).toMatchObject({ selectedReferenceCount: 0, selected: [] });
    await expect(capture(db, foreignProject, 0)).rejects.toMatchObject({ code: "P0002" });
    const own = await seedReference(db, project);
    await react(db, project, own.reference);
    await db.query("update public.identity_reference_heads set selected_reference_count=0 where project_id=$1", [
      project,
    ]);
    await expect(capture(db, project, 1)).rejects.toMatchObject({ code: "55000" });
  });
});

describe("canonical Reference transport and snapshot round trips", () => {
  it("accepts an uppercase route mutation receipt after a real commit", async () => {
    const own = await seedReference(db, project),
      auth = referenceDalAuth(db);
    const outcome = await setReferenceReaction(auth, project.toUpperCase(), own.reference.toUpperCase(), {
      expectedRevision: 0,
      ensemble: true,
      elements: [],
    }).then(
      (data) => ({ data, error: null }),
      (error) => ({ data: null, error }),
    );
    expect(
      (
        await db.query("select revision from public.identity_reference_reactions where reference_id=$1", [
          own.reference,
        ])
      ).rows[0],
    ).toEqual({ revision: 1 });
    expect(outcome.error).toBeNull();
    expect(outcome.data).toMatchObject({
      ownerId: OWNER_A,
      projectId: project,
      entry: { reference: { id: own.reference }, reaction: { revision: 1, ensemble: true } },
    });
  });
  it("normalizes uppercase route and cursor UUIDs before owned reads and query echo comparison", async () => {
    await seedReference(db, project);
    await seedReference(db, project);
    const auth = referenceDalAuth(db),
      first = await getIdentityReferences(auth, project.toUpperCase(), { limit: 1 });
    const cursor = first.references.nextCursor!;
    const next = await getIdentityReferences(auth, project.toUpperCase(), {
      limit: 1,
      cursor: { ...cursor, projectId: cursor.projectId.toUpperCase(), referenceId: cursor.referenceId.toUpperCase() },
    });
    expect(next.query.cursor).toEqual(cursor);
    expect(next.references.items).toHaveLength(1);
    const direct = await readReferences(db, project, {
      limit: 1,
      cursor: { ...cursor, projectId: cursor.projectId.toUpperCase(), referenceId: cursor.referenceId.toUpperCase() },
    });
    expect(direct.query.cursor).toEqual(cursor);
  });
  it("preserves raw frozen snapshot tag arrays through the strict TypeScript parser", async () => {
    const own = await seedReference(db, project, { tags: ["\uE000", "😀"] });
    await react(db, project, own.reference);
    const parsed = await capture(db, project, 1);
    const raw = (
      await db.query<{ snapshot: unknown }>(
        "select snapshot from public.identity_reference_snapshots where project_id=$1",
        [project],
      )
    ).rows[0]!.snapshot;
    expect(parsed).toEqual(raw);
    expect(parsed.selected[0]!.reference.tags).toEqual(["\uE000", "😀"]);
  });
});

describe("canonical attribution at the trusted insertion boundary", () => {
  it("normalizes exact ECMAScript whitespace without changing attribution meaning or raw snapshot bytes", async () => {
    const own = await seedReference(db, project, {
      attribution: {
        label: "\u00a0 A source label \uFEFF",
        creator: "\u2003A creator\u2029",
        sourceUrl: "\u3000https://example.invalid/a%20path?x=1#detail\u00a0",
        rightsNote: "\u202fRights remain unverified.\u1680",
      },
    });
    const receipt = await react(db, project, own.reference);
    expect(receipt.entry.reference.attribution).toEqual({
      label: "A source label",
      creator: "A creator",
      sourceUrl: "https://example.invalid/a%20path?x=1#detail",
      rightsNote: "Rights remain unverified.",
    });
    const parsed = await capture(db, project, 1),
      raw = (
        await db.query<{ snapshot: unknown }>(
          "select snapshot from public.identity_reference_snapshots where project_id=$1",
          [project],
        )
      ).rows[0]!.snapshot;
    expect(parsed).toEqual(raw);
  });
  it.each([
    "https://[broken",
    "https://[bad]/",
    "https://example.invalid:99999/",
    "https://example.invalid:abc/",
    "https://example.invalid:1e2/",
    "https://127.0.0.999/",
    "https://4294967296/",
    "https://%xx.invalid/",
    "https://example.invalid/%zz",
    "https://[::1]/",
    "https://éxample.invalid/",
    "https://example.invalid/café",
    "https://xn--a/",
    "https://xn--b/",
    "https://xn--abc/",
    "https://xn--caf-dma.example/",
    "https://example.xn--p1ai/",
  ])("denies malformed or explicitly unsupported URL before a reaction can commit: %s", async (sourceUrl) => {
    await expect(
      seedReference(db, project, {
        attribution: { label: "Synthetic source", creator: null, sourceUrl, rightsNote: null },
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await db.query("select count(*)::int count from public.identity_reference_reactions")).rows[0]).toEqual({
      count: 0,
    });
  });
  it.each([
    null,
    "https://example.invalid",
    "http://localhost:8080/a?b=2#c",
    "HTTPS://Example.INVALID/path",
    "https://192.0.2.1:8443/a%20b",
    "https://example.invalid/caf%C3%A9",
  ])("roundtrips canonical supported attribution %s", async (sourceUrl) => {
    const own = await seedReference(db, project, {
      attribution: { label: "Synthetic source", creator: null, sourceUrl, rightsNote: null },
    });
    expect((await react(db, project, own.reference)).entry.reference.attribution.sourceUrl).toBe(sourceUrl);
    const parsed = await capture(db, project, 1),
      raw = (
        await db.query<{ snapshot: unknown }>(
          "select snapshot from public.identity_reference_snapshots where project_id=$1",
          [project],
        )
      ).rows[0]!.snapshot;
    expect(parsed).toEqual(raw);
  });
});
