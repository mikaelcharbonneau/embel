import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
vi.mock("server-only", () => ({}));
import {
  createIdentityTransactionService,
  IdentityUncertainCommitError,
  productionIdentityTransactions,
  type IdentityConnectionFactory,
} from "../../src/server/data/identity-transaction";
import { transformNames } from "../../src/domain/naming";
import { identityReferenceSnapshotSchema } from "../../src/domain/identity-references";
import {
  createIdentityInputSnapshot,
  getIdentityFreshness,
  initialIdentityPreferences,
  identityInputSnapshotSchema,
  identityProjectSchema,
  identityPreferenceRevisionSchema,
  identitySessionSchema,
  identitySelectionSchema,
  identitySystemVersionSchema,
  selectIdentitySystem,
  selectIdentitySystemSchema,
  selectIdentitySystemResponseSchema,
  refineIdentityComponent,
  refineIdentityComponentSchema,
  identityRefinementResponseSchema,
  type IdentityRefinementResponse,
  type SelectIdentitySystemResponse,
} from "../../src/domain/project-identity";
import {
  createIdentityTrustedDatabase,
  bindIdentityFixturePrincipals,
  inspectIdentityReplacementCatalog,
  asIdentityFixture,
} from "../database/identity-trusted-replacement-database";
import { createIdentityTrustedConnectionFixture } from "./fixtures/identity-trusted-replacement-connection";
import { OWNER_A, OWNER_B, HASH, asRole, resetFixture, seedProject } from "../database/local-supabase";
import { seedIdentityRoot } from "../database/identity-system-database";
import { react, seedReference } from "../database/identity-reference-database";

type Database = Awaited<ReturnType<typeof createIdentityTrustedDatabase>>;
async function snapshot(db: Database) {
  const state: Record<string, Record<string, unknown>[]> = {};
  for (const table of [
    "projects",
    "project_revisions",
    "identity_reference_heads",
    "identity_references",
    "identity_reference_reactions",
    "identity_reference_snapshots",
    "identity_sessions",
    "identity_preferences",
    "identity_input_snapshots",
    "identity_batches",
    "identity_generated_roots",
    "identity_system_versions",
    "identity_system_files",
    "identity_selections",
    "identity_component_changes",
    "asset_usages",
    "assets",
    "asset_versions",
    "jobs",
    "job_steps",
  ]) {
    state[table] = (
      await db.query(`select to_jsonb(row) value from public.${table} row order by to_jsonb(row)::text`)
    ).rows.map((row) => (row as { value: Record<string, unknown> }).value);
  }
  return state;
}

// NEW local acceptance. Helpers must execute in restricted PostgreSQL, never
// through the retained administrator-bound helper-interception fixture.
describe("new restricted Identity SQL replacement", () => {
  let db: Awaited<ReturnType<typeof createIdentityTrustedDatabase>>;
  let project: string, root: Awaited<ReturnType<typeof seedIdentityRoot>>;
  let fixture: ReturnType<typeof createIdentityTrustedConnectionFixture>;
  beforeAll(async () => {
    db = await createIdentityTrustedDatabase();
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await resetFixture(db);
    await bindIdentityFixturePrincipals(db);
    project = (await seedProject(db)).id;
    root = await seedIdentityRoot(db, project);
    fixture = createIdentityTrustedConnectionFixture(db);
  });
  const request = () => ({
    systemVersionId: root.system.id,
    expectedProjectRevision: root.input.projectRevision,
    expectedReferenceRevision: root.input.referenceSnapshot.referenceRevision,
    expectedPreferencesRevision: 0,
    expectedIdentityRevision: 0,
    acceptEarlierBasis: false,
  });
  const edit = () => {
    const { systemVersionId, ...fences } = request();
    return {
      ...fences,
      baseSystemVersionId: systemVersionId,
      component: "colors" as const,
      input: { swatches: [{ key: "primary", name: "New", hex: "#ABCDEF" }], usageNotes: "User palette" },
      idempotencyKey: "replacement-edit-original",
    };
  };
  async function saveContext(context: unknown) {
    await asRole(db, "authenticated", OWNER_A, () =>
      db.query("select public.append_project_revision($1,$2,$3::jsonb,$4)", [
        project,
        root.input.projectRevision,
        JSON.stringify(context),
        HASH,
      ]),
    );
  }
  async function seedSibling(accepted: boolean, separateStep: boolean, incorrectIndex = false) {
    const id = randomUUID(),
      assetId = randomUUID(),
      versionId = randomUUID(),
      contentHash = createHash("sha256").update(versionId).digest("hex");
    await db.query(
      "insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'Explicit synthetic sibling board','brand_asset')",
      [assetId, OWNER_A, project],
    );
    await db.query(
      "insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,storage_path,provenance) values($1,$2,$3,$4,1,$5,$6,$7,'image/png',$8,'{}')",
      [
        versionId,
        OWNER_A,
        project,
        assetId,
        root.input.projectRevision,
        HASH,
        contentHash,
        `${OWNER_A}/${project}/${assetId}/${versionId}`,
      ],
    );
    const asset = { ...root.system.board.asset, assetId, versionId, contentHash },
      stepKey = separateStep ? `${root.stepKey}.sibling` : root.stepKey;
    const system = {
      ...root.system,
      id,
      source: { ...root.system.source, stepKey },
      board: { asset, depictsSystemVersionId: id, staleComponents: [] },
      productionFiles: [],
    };
    const output = {
      identity: {
        ...root.output.identity,
        stepKey,
        systems: separateStep ? [structuredClone(system)] : [root.system, structuredClone(system)],
      },
    };
    if (separateStep)
      await db.query(
        "insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,output,completed_at) values($1,$2,$3,$4,$5,'succeeded',0,$6::jsonb,$7)",
        [root.jobId, OWNER_A, project, stepKey, `sibling-${id}`, JSON.stringify(output), root.system.createdAt],
      );
    else
      await db.query("update public.job_steps set output=$2::jsonb where job_id=$1 and step_key=$3", [
        root.jobId,
        JSON.stringify(output),
        stepKey,
      ]);
    if (accepted) {
      await db.query(
        "insert into public.identity_system_versions(id,project_id,owner_id,input_id,source,components,board,production_files,created_at,root_system_id,created_at_text) select $1,project_id,owner_id,input_id,$2::jsonb,components,$3::jsonb,'[]',created_at,$1,created_at_text from public.identity_system_versions where id=$4",
        [id, JSON.stringify(system.source), JSON.stringify(system.board), root.system.id],
      );
      await db.query(
        "insert into public.identity_system_files(system_id,slot,project_id,owner_id,component,role,asset_id,version_id) values($1,0,$2,$3,null,'board',$4,$5)",
        [id, project, OWNER_A, assetId, versionId],
      );
      await db.query(
        "insert into public.identity_generated_roots(system_id,project_id,owner_id,batch_id,job_id,step_key,output_index,board) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
        [
          id,
          project,
          OWNER_A,
          root.batchId,
          root.jobId,
          stepKey,
          incorrectIndex ? 2 : separateStep ? 0 : 1,
          JSON.stringify(asset),
        ],
      );
    }
    return { system, output, stepKey };
  }
  it("installs exact restricted entrypoints and denies raw application access", async () => {
    const catalog = await inspectIdentityReplacementCatalog(db);
    expect(catalog.verified).toBe(true);
    const lease = await fixture.factory.acquire(OWNER_A);
    const login = await lease.connection.query("select session_user::text role_name, current_user::text current_name");
    expect(login.rows).toEqual([
      { role_name: "fixture_identity_replacement_a", current_name: "fixture_identity_replacement_a" },
    ]);
    await expect(lease.connection.query("select * from public.identity_selections")).rejects.toMatchObject({
      code: "42501",
    });
    await lease.connection.release(false);
  });
  it("commits one real selection and its exact usages through restricted helpers", async () => {
    const result = await createIdentityTransactionService(fixture.factory).select(
      { userId: OWNER_A },
      project,
      request(),
    );
    expect(result.currentSelection.system).toEqual(root.system);
    expect(
      (await db.query("select identity_revision,current_selection_id from public.identity_sessions")).rows,
    ).toEqual([{ identity_revision: 1, current_selection_id: result.currentSelection.selection.id }]);
    expect((await db.query("select count(*)::int count from public.asset_usages")).rows).toEqual([{ count: 2 }]);
    expect(fixture.events.filter((e) => e.kind === "prepare")).toHaveLength(1);
    expect(fixture.events.filter((e) => e.kind === "commit_helper")).toHaveLength(1);
    expect(fixture.inspect().phase).toBe("available");
  });
  it("persists and replays the original manual edit without a second helper write", async () => {
    const { systemVersionId, ...fences } = request();
    const edit = {
      ...fences,
      baseSystemVersionId: systemVersionId,
      component: "colors",
      input: {
        swatches: [{ key: "primary", name: "New", hex: "#ABCDEF" }],
        usageNotes: "User palette",
      },
      idempotencyKey: "replacement-refine-first",
    };
    const service = createIdentityTransactionService(fixture.factory);
    const first = await service.refine({ userId: OWNER_A }, project, edit);
    expect(await service.refine({ userId: OWNER_A }, project, edit)).toEqual(first);
    expect(first.system.input).toEqual(root.input);
    expect(first.system.board.staleComponents).toEqual(["colors"]);
    expect(first.system.productionFiles).toEqual([]);
    expect((await db.query("select count(*)::int count from public.identity_component_changes")).rows).toEqual([
      { count: 1 },
    ]);
    expect(fixture.events.filter((e) => e.kind === "commit_helper")).toHaveLength(1);
  });
  it.each([
    "expectedProjectRevision",
    "expectedReferenceRevision",
    "expectedPreferencesRevision",
    "expectedIdentityRevision",
  ] as const)("rejects stale %s before any selection write", async (key) => {
    const body = request(),
      before = await snapshot(db);
    await expect(
      createIdentityTransactionService(fixture.factory).select({ userId: OWNER_A }, project, {
        ...body,
        [key]: body[key] + 1,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await db.query("select * from public.identity_selections")).rows).toEqual([]);
    expect((await db.query("select * from public.asset_usages")).rows).toEqual([]);
    expect(fixture.events.filter((e) => e.kind === "commit_helper")).toEqual([]);
    expect(await snapshot(db)).toEqual(before);
  });
  it("keeps production unavailable and rejects caller identity before acquisition", async () => {
    await expect(productionIdentityTransactions.select({ userId: OWNER_A }, project, request())).rejects.toMatchObject({
      code: "integration_unavailable",
    });
    await expect(
      createIdentityTransactionService(fixture.factory).select({ userId: OWNER_A }, project, {
        ...request(),
        ownerId: OWNER_B,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fixture.events).toEqual([]);
  });
  it("permits both bound owners and rejects foreign owner/project sources without row effects", async () => {
    const otherProject = (await seedProject(db, OWNER_B)).id;
    const otherRoot = await seedIdentityRoot(db, otherProject, { ownerId: OWNER_B });
    const ownOther = (await seedProject(db)).id;
    await seedIdentityRoot(db, ownOther);
    const before = await snapshot(db),
      service = createIdentityTransactionService(fixture.factory);
    await expect(service.select({ userId: OWNER_B }, project, request())).rejects.toMatchObject({ code: "not_found" });
    await expect(service.select({ userId: OWNER_A }, ownOther, request())).rejects.toMatchObject({ code: "not_found" });
    expect(await snapshot(db)).toEqual(before);
    const result = await service.select({ userId: OWNER_B }, otherProject, {
      ...request(),
      systemVersionId: otherRoot.system.id,
    });
    expect(result.currentSelection.system.ownerId).toBe(OWNER_B);
  });
  it("rejects a forged actual GUC and raw definer access with no persisted effect", async () => {
    const before = await snapshot(db);
    await asIdentityFixture(db, OWNER_A, async () => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_B]);
      await expect(
        db.query("select fluid_private.prepare_identity_transaction($1,$2,false)", [
          project,
          JSON.stringify(request()),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select fluid_private.identity_web_owner()")).rejects.toMatchObject({ code: "42501" });
      await expect(db.exec("set role fluid_identity_writer_definer_v1")).rejects.toMatchObject({ code: "42501" });
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_A]);
      await db.exec("begin");
      await db.query("select fluid_private.prepare_identity_transaction($1,$2,false)", [
        project,
        JSON.stringify(request()),
      ]);
      await expect(db.query("select * from pg_temp.identity_transaction_preparation")).rejects.toMatchObject({
        code: "42501",
      });
    });
    expect(await snapshot(db)).toEqual(before);
  });
  it("rejects actual login rename and same-name new-OID recreation against the immutable binding", async () => {
    const before = await snapshot(db);
    await db.exec("begin; alter role fixture_identity_replacement_a rename to fixture_identity_replacement_renamed");
    try {
      await db.exec("set session authorization fixture_identity_replacement_renamed; savepoint renamed");
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [OWNER_A]);
      await expect(
        db.query("select fluid_private.prepare_identity_transaction($1,$2,false)", [
          project,
          JSON.stringify(request()),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await db.exec("rollback to renamed; set session authorization postgres");
      await db.exec(`create role fixture_identity_replacement_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
        grant usage on schema fluid_private to fixture_identity_replacement_a;
        grant execute on function fluid_private.prepare_identity_transaction(uuid,jsonb,boolean) to fixture_identity_replacement_a;
        set session authorization fixture_identity_replacement_a; savepoint recreated`);
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [OWNER_A]);
      await expect(
        db.query("select fluid_private.prepare_identity_transaction($1,$2,false)", [
          project,
          JSON.stringify(request()),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.exec("rollback; set session authorization postgres");
    }
    expect(await snapshot(db)).toEqual(before);
    expect((await inspectIdentityReplacementCatalog(db)).verified).toBe(true);
  });
  it("retains two immutable edits, restores earlier history and replays the original intent after invalid current context", async () => {
    const service = createIdentityTransactionService(fixture.factory),
      first = await service.refine({ userId: OWNER_A }, project, edit());
    const second = await service.refine({ userId: OWNER_A }, project, {
      ...edit(),
      baseSystemVersionId: first.system.id,
      expectedIdentityRevision: 1,
      component: "typography",
      input: {
        styles: [{ key: "body", role: "Body", family: "Changed Family", weight: 500, style: "italic" }],
        usageNotes: "Fixture specification",
      },
      idempotencyKey: "replacement-edit-second",
    });
    expect(second.system.input).toEqual(root.input);
    expect(second.system.board.staleComponents).toEqual(["colors", "typography"]);
    expect(second.system.productionFiles).toEqual([]);
    const restored = await service.select({ userId: OWNER_A }, project, {
      ...request(),
      systemVersionId: first.system.id,
      expectedIdentityRevision: 2,
    });
    expect(restored.currentSelection.selection.reason).toBe("restored");
    expect(restored.currentSelection.selection.identityRevision).toBe(3);
    await saveContext({
      ...root.input.context,
      competitors: [
        {
          id: OWNER_A,
          name: "Invalid",
          relevance: "Fixture",
          origin: "user",
          selected: true,
          url: "https://[broken",
          sources: [],
        },
      ],
    });
    const before = await snapshot(db),
      writes = fixture.events.filter((e) => e.kind === "commit_helper").length;
    expect(await service.refine({ userId: OWNER_A }, project, edit())).toEqual(first);
    await expect(
      service.refine({ userId: OWNER_A }, project, { ...edit(), acceptEarlierBasis: true }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await snapshot(db)).toEqual(before);
    expect(fixture.events.filter((e) => e.kind === "commit_helper")).toHaveLength(writes);
    expect((await db.query("select current_selection_id from public.identity_sessions")).rows).toEqual([
      { current_selection_id: restored.currentSelection.selection.id },
    ]);
  });
  it("accepts sparse historical contexts through the unchanged shared normalizer", async () => {
    const sparseProject = (await seedProject(db)).id;
    const sparse = await seedIdentityRoot(db, sparseProject, {
      rawContext: { description: "Sparse local source", selectedName: "Cedar", intake: { suppliedName: "Cedar" } },
    });
    const result = await createIdentityTransactionService(fixture.factory).select({ userId: OWNER_A }, sparseProject, {
      ...request(),
      systemVersionId: sparse.system.id,
    });
    expect(result.currentSelection.system).toEqual(sparse.system);
  });
  it.each(["valid WHATWG", "invalid URL", "valid Naming", "invalid Naming"])(
    "validates %s in the actual-SQL service path",
    async (scenario) => {
      let context: unknown;
      if (scenario.includes("Naming")) {
        const input = { kind: "tweaks" as const, seed: "Cedar", operations: ["uppercase" as const] },
          output = transformNames(input).candidates[0]!.value;
        context = {
          ...root.input.context,
          namingSource: {
            id: randomUUID(),
            value: output,
            createdAt: root.system.createdAt,
            origin: "workshop",
            history: [
              {
                id: randomUUID(),
                input,
                output: scenario === "invalid Naming" ? "Invented" : output,
                createdAt: root.system.createdAt,
              },
            ],
          },
        };
      } else
        context = {
          ...root.input.context,
          competitors: [
            {
              id: OWNER_A,
              name: "Peer",
              relevance: "Fixture",
              origin: "research",
              selected: true,
              url: scenario === "invalid URL" ? "https://[broken" : "HTTPS://[2001:db8::1]:443/path",
              sources: [{ url: "HTTPS://例え.テスト/path", title: "Source", retrievedAt: root.system.createdAt }],
            },
          ],
        };
      await saveContext(context);
      const before = await snapshot(db);
      const result = createIdentityTransactionService(fixture.factory).select({ userId: OWNER_A }, project, {
        ...request(),
        expectedProjectRevision: root.input.projectRevision + 1,
        acceptEarlierBasis: true,
      });
      if (scenario.startsWith("invalid")) {
        await expect(result).rejects.toMatchObject({ code: "integration_unavailable" });
        expect(await snapshot(db)).toEqual(before);
        expect(fixture.events.filter((e) => e.kind === "commit_helper")).toEqual([]);
      } else expect((await result).currentSelection.system.id).toBe(root.system.id);
    },
  );
  it.each([false, true])(
    "proves inherited PUBLIC functions confer no worker authority; diagnostic failure=%s",
    async (failProbe) => {
      const foreign = (await seedProject(db, OWNER_B)).id,
        foreignRoot = await seedIdentityRoot(db, foreign, { ownerId: OWNER_B });
      const before = await snapshot(db),
        originalCatalog = await inspectIdentityReplacementCatalog(db);
      const roles = [
        "fixture_identity_replacement_a",
        "fixture_identity_replacement_b",
        "fixture_identity_replacement_unbound",
        "fluid_identity_writer_definer_v1",
      ];
      const observe = async () => {
        await db.exec(`begin;
        create temporary table identity_replacement_probe_namespace(value integer) on commit drop;
        create function pg_temp.identity_replacement_worker_probe(p_job uuid,p_owner uuid) returns jsonb
        language sql stable security definer set search_path='' as $probe$
          select pg_catalog.jsonb_build_object('session',session_user,'current',current_user,
            'workerOwner',public.subscription_worker_owner(),'apiWorkerOwner',public.api_text_worker_owner(),'job',p_job,'owner',p_owner)
        $probe$;
        alter function pg_temp.identity_replacement_worker_probe(uuid,uuid) owner to fluid_identity_writer_definer_v1;
        revoke all on function pg_temp.identity_replacement_worker_probe(uuid,uuid) from public;
        grant execute on function pg_temp.identity_replacement_worker_probe(uuid,uuid) to fixture_identity_replacement_a,fixture_identity_replacement_b,fixture_identity_replacement_unbound;`);
        try {
          for (const role of roles) {
            await db.exec(`set session authorization ${role}`);
            for (const claim of [OWNER_A, OWNER_B]) {
              await db.query(
                "select set_config('request.jwt.claim.sub',$1,true),set_config('fluid.identity.validated','true',true)",
                [claim],
              );
              for (const [job, owner] of [
                [root.jobId, OWNER_A],
                [foreignRoot.jobId, OWNER_B],
              ]) {
                if (role === "fluid_identity_writer_definer_v1") {
                  // The helper can still execute the two old worker identity functions; it is no worker.
                  expect(
                    (
                      await db.query(
                        "select session_user::text session,current_user::text current,public.subscription_worker_owner() worker_owner,public.api_text_worker_owner() api_worker_owner",
                      )
                    ).rows,
                  ).toEqual([{ session: role, current: role, worker_owner: null, api_worker_owner: null }]);
                } else {
                  // Since 20261110160000 the replacement logins cannot even call them.
                  for (const sql of [
                    "select public.subscription_worker_owner()",
                    "select public.api_text_worker_owner()",
                  ]) {
                    await db.exec("savepoint denied_predicate");
                    await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
                    await db.exec("rollback to denied_predicate");
                  }
                }
                expect(
                  (await db.query("select pg_temp.identity_replacement_worker_probe($1,$2) value", [job, owner])).rows,
                ).toEqual([
                  {
                    value: {
                      session: role,
                      current: "fluid_identity_writer_definer_v1",
                      workerOwner: null,
                      apiWorkerOwner: null,
                      job,
                      owner,
                    },
                  },
                ]);
              }
            }
            for (const sql of [
              "select * from fluid_private.subscription_worker_principals",
              "update fluid_private.subscription_worker_principals set role_oid=role_oid where false",
              "delete from fluid_private.subscription_worker_principals where false",
              "select * from fluid_private.api_text_worker_principals",
              "update fluid_private.api_text_worker_principals set role_oid=role_oid where false",
              "delete from fluid_private.api_text_worker_principals where false",
            ]) {
              await db.exec("savepoint denied_worker_access");
              await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
              await db.exec("rollback to denied_worker_access");
            }
          }
          if (failProbe) throw new Error("fixture diagnostic observation failed");
        } finally {
          await db.exec("rollback; set session authorization postgres");
        }
      };
      if (failProbe) await expect(observe()).rejects.toThrow("fixture diagnostic observation failed");
      else await observe();
      expect(
        (await db.query("select oid from pg_catalog.pg_proc where proname='identity_replacement_worker_probe'")).rows,
      ).toEqual([]);
      const afterCatalog = await inspectIdentityReplacementCatalog(db);
      expect(afterCatalog.inheritedAfter).toEqual(originalCatalog.inheritedBefore);
      expect(afterCatalog.workerBindings).toEqual([]);
      expect(await snapshot(db)).toEqual(before);
    },
  );
  it.each([
    "worker binding",
    "API worker binding",
    "API predicate definition",
    "API predicate ACL",
    "unlisted callable",
    "public entrypoint",
    "binding write",
    "unlisted data",
  ])("fails the catalog gate on an unexpected %s", async (fault) => {
    await db.exec("begin");
    try {
      if (fault === "worker binding")
        await db.query(
          "insert into fluid_private.subscription_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_catalog.pg_roles where rolname='fixture_identity_replacement_a'",
          [OWNER_A],
        );
      else if (fault === "API worker binding")
        await db.query(
          "insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_catalog.pg_roles where rolname='fixture_identity_replacement_a'",
          [OWNER_A],
        );
      else if (fault === "API predicate definition")
        await db.exec(
          "create or replace function public.api_text_worker_owner() returns uuid language sql stable security definer set search_path='' as 'select null::uuid'",
        );
      else if (fault === "API predicate ACL")
        await db.exec(
          "grant execute on function public.api_text_worker_owner() to fixture_identity_replacement_a with grant option",
        );
      else if (fault === "public entrypoint")
        await db.exec(
          "grant execute on function fluid_private.prepare_identity_transaction(uuid,jsonb,boolean) to public",
        );
      else if (fault === "binding write")
        await db.exec("grant update on fluid_private.identity_web_principals to fixture_identity_replacement_a");
      else if (fault === "unlisted data")
        await db.exec("grant select on fluid_private.subscription_worker_principals to fixture_identity_replacement_a");
      // New functions are private by default (20261110160000); the fault is a PUBLIC grant.
      else
        await db.exec(
          "create function public.identity_unexpected_fixture_capability() returns integer language sql as 'select 1'; grant execute on function public.identity_unexpected_fixture_capability() to public",
        );
      const expected = {
        "worker binding": "no worker binding",
        "API worker binding": "no worker binding",
        "API predicate definition": "unchanged inherited definition/ACL",
        "API predicate ACL": "unchanged inherited definition/ACL",
        "public entrypoint": "no replacement PUBLIC execute",
        "binding write": "private binding rights",
        "unlisted data": "no unlisted data relation rights",
        "unlisted callable": "exact callable functions",
      };
      await expect(inspectIdentityReplacementCatalog(db)).rejects.toThrow(expected[fault as keyof typeof expected]);
    } finally {
      await db.exec("rollback");
    }
    expect((await inspectIdentityReplacementCatalog(db)).verified).toBe(true);
  });
  it.each([
    "job operation",
    "job revision",
    "step state",
    "output owner",
    "output system",
    "output file",
    "extra output field",
  ])("rejects corrupted actual %s without mutation", async (fault) => {
    if (fault === "job operation")
      await db.query("update public.jobs set operation='strategy' where id=$1", [root.jobId]);
    else if (fault === "job revision")
      await db.query("update public.jobs set input_revision=input_revision-1 where id=$1", [root.jobId]);
    else if (fault === "step state")
      await db.query("update public.job_steps set state='failed' where job_id=$1", [root.jobId]);
    else {
      const output = structuredClone(root.output) as { identity: Record<string, unknown> };
      if (fault === "output owner") output.identity.ownerId = OWNER_B;
      if (fault === "output system") (output.identity.systems as Array<{ id: string }>)[0]!.id = randomUUID();
      if (fault === "output file")
        (output.identity.systems as Array<{ board: { asset: { versionId: string } } }>)[0]!.board.asset.versionId =
          randomUUID();
      if (fault === "extra output field") output.identity.extra = true;
      await db.query("update public.job_steps set output=$2::jsonb where job_id=$1", [
        root.jobId,
        JSON.stringify(output),
      ]);
    }
    const before = await snapshot(db);
    await expect(
      createIdentityTransactionService(fixture.factory).select({ userId: OWNER_A }, project, request()),
    ).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(fixture.failures).toContainEqual(expect.objectContaining({ code: "55000" }));
    expect(await snapshot(db)).toEqual(before);
    expect(fixture.events.filter((e) => e.kind === "commit_helper")).toEqual([]);
  });
  it.each(["selection", "refinement"] as const)(
    "verifies accepted siblings across source steps for %s",
    async (operation) => {
      await seedSibling(true, true);
      const service = createIdentityTransactionService(fixture.factory);
      if (operation === "selection")
        expect((await service.select({ userId: OWNER_A }, project, request())).currentSelection.system).toEqual(
          root.system,
        );
      else expect((await service.refine({ userId: OWNER_A }, project, edit())).system.input).toEqual(root.input);
    },
  );
  it.each(["selection", "refinement"] as const)(
    "verifies complete same-step output including unaccepted siblings for %s",
    async (operation) => {
      await seedSibling(false, false);
      const service = createIdentityTransactionService(fixture.factory);
      if (operation === "selection")
        expect((await service.select({ userId: OWNER_A }, project, request())).currentSelection.system.id).toBe(
          root.system.id,
        );
      else expect((await service.refine({ userId: OWNER_A }, project, edit())).system.input).toEqual(root.input);
    },
  );
  it.each(["selection", "refinement"] as const)(
    "rejects a corrupt accepted sibling output index for %s with zero effects",
    async (operation) => {
      await seedSibling(true, true, true);
      const before = await snapshot(db),
        service = createIdentityTransactionService(fixture.factory);
      const result =
        operation === "selection"
          ? service.select({ userId: OWNER_A }, project, request())
          : service.refine({ userId: OWNER_A }, project, edit());
      await expect(result).rejects.toMatchObject({ code: "integration_unavailable" });
      expect(await snapshot(db)).toEqual(before);
      expect(fixture.failures).toContainEqual(expect.objectContaining({ code: "55000" }));
      expect(fixture.events.filter((e) => e.kind === "commit_helper")).toEqual([]);
    },
  );
  it.each(["foreign owner", "duplicate board", "invalid Naming", "unbound asset"])(
    "rejects %s in an unaccepted sibling without filtering that source",
    async (fault) => {
      const sibling = await seedSibling(false, false),
        output = structuredClone(sibling.output);
      if (fault === "foreign owner") output.identity.systems[1]!.ownerId = OWNER_B;
      if (fault === "duplicate board") output.identity.systems[1]!.board.asset = root.system.board.asset;
      if (fault === "unbound asset") output.identity.systems[1]!.board.asset.versionId = randomUUID();
      if (fault === "invalid Naming")
        output.identity.systems[1]!.input.context.namingSource = {
          id: randomUUID(),
          value: "Cedar",
          origin: "workshop",
          createdAt: root.system.createdAt,
          history: [
            {
              id: randomUUID(),
              input: { kind: "tweaks", seed: "Cedar", operations: ["uppercase"] },
              output: "Invented",
              createdAt: root.system.createdAt,
            },
          ],
        };
      await db.query("update public.job_steps set output=$2::jsonb where job_id=$1 and step_key=$3", [
        root.jobId,
        JSON.stringify(output),
        root.stepKey,
      ]);
      const before = await snapshot(db);
      await expect(
        createIdentityTransactionService(fixture.factory).select({ userId: OWNER_A }, project, request()),
      ).rejects.toMatchObject({ code: "integration_unavailable" });
      expect(await snapshot(db)).toEqual(before);
      expect(fixture.events.filter((e) => e.kind === "commit_helper")).toEqual([]);
    },
  );
  it("accepts a succeeded source step when the job later failed", async () => {
    await db.query("update public.jobs set state='failed' where id=$1", [root.jobId]);
    const result = await createIdentityTransactionService(fixture.factory).select(
      { userId: OWNER_A },
      project,
      request(),
    );
    expect(result.currentSelection.system).toEqual(root.system);
  });
  it.each([
    ...["session", "snapshot", "selection", "usages", "head", "assets"].map((stage) => ({
      operation: "selection",
      stage,
    })),
    ...["session", "snapshot", "system", "files", "selection", "usages", "change", "head", "assets"].map((stage) => ({
      operation: "refinement",
      stage,
    })),
  ])(
    "rolls back actual $operation $stage writes through a database trigger failure",
    async ({ operation: action, stage }) => {
      // A legitimate reference reaction leaves a current snapshot to be written by commit.
      const reference = await seedReference(db, project);
      const changed = await react(db, project, reference.reference, {
        expectedRevision: 0,
        ensemble: true,
        elements: [],
      });
      const body = {
        ...(action === "selection" ? request() : edit()),
        expectedReferenceRevision: changed.referenceRevision,
        acceptEarlierBasis: true,
      };
      const stages: Record<string, [string, string]> = {
        session: ["identity_sessions", "insert"],
        snapshot: ["identity_reference_snapshots", "insert"],
        system: ["identity_system_versions", "insert"],
        files: ["identity_system_files", "insert"],
        selection: ["identity_selections", "insert"],
        usages: ["asset_usages", "insert"],
        change: ["identity_component_changes", "insert"],
        head: ["identity_sessions", "update"],
        assets: ["assets", "update"],
      };
      const [table, operation] = stages[stage]!;
      await db.exec(`begin;
      create function fluid_private.identity_replacement_test_failure() returns trigger language plpgsql set search_path='' as $fault$
      begin raise exception 'fixture_write_failure:${stage}' using errcode='PT599'; end $fault$;
      revoke all on function fluid_private.identity_replacement_test_failure() from public;
      create trigger identity_replacement_test_failure after ${operation} on public.${table} for each row execute function fluid_private.identity_replacement_test_failure(); commit;`);
      const before = await snapshot(db);
      try {
        const service = createIdentityTransactionService(fixture.factory);
        await expect(
          action === "selection"
            ? service.select({ userId: OWNER_A }, project, body)
            : service.refine({ userId: OWNER_A }, project, body),
        ).rejects.toMatchObject({ code: "integration_unavailable" });
        expect(fixture.failures).toContainEqual(
          expect.objectContaining({ code: "PT599", message: `fixture_write_failure:${stage}` }),
        );
        expect(await snapshot(db)).toEqual(before);
        expect(fixture.events.filter((e) => e.kind === "commit_helper")).toHaveLength(1);
        expect(fixture.events.some((e) => e.kind === "COMMIT")).toBe(false);
      } finally {
        await db.exec(
          `drop trigger identity_replacement_test_failure on public.${table}; drop function fluid_private.identity_replacement_test_failure()`,
        );
      }
    },
  );
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.each(["selection", "refinement"] as const)("actual SQL %s connection lifetime", (operation) => {
  let db: Database, project: string, root: Awaited<ReturnType<typeof seedIdentityRoot>>;
  let fixture: ReturnType<typeof createIdentityTrustedConnectionFixture>, before: Awaited<ReturnType<typeof snapshot>>;
  let body: Record<string, unknown>, observed: Awaited<ReturnType<typeof snapshot>> | undefined;
  const controller = () => new AbortController();
  beforeEach(async () => {
    db = await createIdentityTrustedDatabase();
    await resetFixture(db);
    await bindIdentityFixturePrincipals(db);
    project = (await seedProject(db)).id;
    root = await seedIdentityRoot(db, project);
    fixture = createIdentityTrustedConnectionFixture(db);
    const fences = {
      expectedProjectRevision: root.input.projectRevision,
      expectedReferenceRevision: root.input.referenceSnapshot.referenceRevision,
      expectedPreferencesRevision: 0,
      expectedIdentityRevision: 0,
      acceptEarlierBasis: false,
    };
    body =
      operation === "selection"
        ? { systemVersionId: root.system.id, ...fences }
        : {
            baseSystemVersionId: root.system.id,
            ...fences,
            component: "colors",
            input: { swatches: [{ key: "primary", name: "New", hex: "#ABCDEF" }], usageNotes: "User palette" },
            idempotencyKey: "uncertain-original-intent",
          };
    before = await snapshot(db);
    observed = undefined;
    fixture.hooks.beforeDispose = async () => {
      observed = await snapshot(db);
    };
  }, 30_000);
  afterEach(async () => {
    if (db && !db.closed) await db.close();
  });
  function run(signal?: AbortSignal, factory: IdentityConnectionFactory = fixture.factory) {
    const service = createIdentityTransactionService(factory),
      supplied = structuredClone(body);
    const target = operation === "selection" ? "systemVersionId" : "baseSystemVersionId";
    supplied[target] = String(supplied[target]).toUpperCase();
    if (operation === "refinement") {
      const input = supplied.input as { swatches: Array<{ name: string; hex: string }> };
      input.swatches[0]!.name = " New ";
      input.swatches[0]!.hex = "#abcdef";
    }
    return (
      operation === "selection"
        ? service.select({ userId: OWNER_A }, project, supplied, signal)
        : service.refine({ userId: OWNER_A }, project, supplied, signal)
    ).then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error: error as Error }),
    );
  }
  function assertDispatches() {
    expect(fixture.events.filter((e) => e.kind === "prepare")).toHaveLength(1);
    expect(fixture.events.filter((e) => e.kind === "commit_helper")).toHaveLength(1);
  }
  function assertUncertain(error: unknown) {
    expect(error).toBeInstanceOf(IdentityUncertainCommitError);
    expect((error as IdentityUncertainCommitError).recovery).toEqual({
      operation,
      action: operation === "selection" ? "read_before_explicit_retry" : "replay_same_intent",
      request: body,
    });
    assertDispatches();
  }
  async function assertTombstone() {
    const another = createIdentityTrustedConnectionFixture(db);
    await expect(another.factory.acquire(OWNER_A)).rejects.toThrow("quarantined backend");
    expect(another.events).toEqual([]);
    expect(["closed", "quarantined"]).toContain(fixture.inspect().phase);
  }
  function assertEffects(state: Awaited<ReturnType<typeof snapshot>> | undefined, committed: boolean) {
    expect(state).toBeDefined();
    if (!state) throw new Error("No verified-idle SQL observation");
    if (!committed) {
      expect(state).toEqual(before);
      return;
    }
    const changed = new Set([
      "identity_sessions",
      "identity_system_versions",
      "identity_system_files",
      "identity_selections",
      "identity_component_changes",
      "asset_usages",
      "assets",
    ]);
    for (const table of Object.keys(before))
      if (!changed.has(table)) expect(state[table], table).toEqual(before[table]);
    expect(state.identity_selections).toHaveLength(1);
    const selection = state.identity_selections![0]!;
    expect(selection).toEqual({
      id: expect.any(String),
      owner_id: OWNER_A,
      project_id: project,
      system_id: operation === "selection" ? root.system.id : expect.any(String),
      identity_revision: 1,
      project_revision: body.expectedProjectRevision,
      reference_revision: body.expectedReferenceRevision,
      preferences_revision: null,
      current_basis: root.input.basis,
      accepted_earlier_basis: false,
      previous_selection_id: null,
      reason: operation === "selection" ? "selected" : "refined",
      created_at: expect.any(String),
    });
    expect(state.identity_sessions).toEqual([
      {
        owner_id: OWNER_A,
        project_id: project,
        identity_revision: 1,
        current_selection_id: selection.id,
        current_preferences_revision: null,
        created_at: selection.created_at,
        updated_at: selection.created_at,
      },
    ]);
    const files =
      operation === "selection"
        ? [{ asset: root.system.board.asset }, ...root.system.productionFiles]
        : [{ asset: root.system.board.asset }];
    const usages = state.asset_usages!.slice().sort((a, b) => Number(a.slot) - Number(b.slot));
    expect(usages).toEqual(
      files.map(({ asset }, slot) => ({
        selection_id: selection.id,
        system_id: selection.system_id,
        slot,
        owner_id: OWNER_A,
        project_id: project,
        asset_id: asset.assetId,
        version_id: asset.versionId,
      })),
    );
    expect(state.assets).toEqual(
      before.assets!.map((asset) => ({
        ...asset,
        used: Boolean(asset.legacy_used) || files.some((file) => file.asset.assetId === asset.id),
      })),
    );
    if (operation === "selection") {
      expect(state.identity_system_versions).toEqual(before.identity_system_versions);
      expect(state.identity_system_files).toEqual(before.identity_system_files);
      expect(state.identity_component_changes).toEqual([]);
    } else {
      expect(state.identity_component_changes).toHaveLength(1);
      const change = state.identity_component_changes![0]!;
      expect(change).toEqual({
        id: expect.any(String),
        owner_id: OWNER_A,
        project_id: project,
        base_system_id: root.system.id,
        result_system_id: selection.system_id,
        selection_id: selection.id,
        component: "colors",
        before_value: root.system.components.colors,
        after_value: body.input,
        project_revision: body.expectedProjectRevision,
        reference_revision: body.expectedReferenceRevision,
        preferences_revision: null,
        current_basis: root.input.basis,
        accepted_earlier_basis: false,
        idempotency_key: body.idempotencyKey,
        intent: body,
        created_at: selection.created_at,
      });
      const original = before.identity_system_versions![0]!;
      const added = state.identity_system_versions!.find((row) => row.id !== root.system.id)!;
      expect(state.identity_system_versions!.filter((row) => row.id === root.system.id)).toEqual(
        before.identity_system_versions,
      );
      expect(added).toEqual({
        ...original,
        id: selection.system_id,
        base_system_id: root.system.id,
        change_id: change.id,
        source: {
          kind: "manual_edit",
          baseSystemVersionId: root.system.id,
          changeId: change.id,
          component: "colors",
          editedAtProjectRevision: body.expectedProjectRevision,
          editedAtReferenceRevision: body.expectedReferenceRevision,
          editedAtPreferencesRevision: 0,
        },
        components: { ...root.system.components, colors: body.input },
        board: { ...root.system.board, staleComponents: ["colors"] },
        production_files: [],
        created_at: selection.created_at,
        created_at_text: selection.created_at,
        created_at_order: expect.any(Number),
      });
      expect(state.identity_system_versions).toHaveLength(2);
      expect(state.identity_system_files!.filter((row) => row.system_id === root.system.id)).toEqual(
        before.identity_system_files,
      );
      expect(state.identity_system_files!.filter((row) => row.system_id === selection.system_id)).toEqual([
        {
          system_id: selection.system_id,
          slot: 0,
          owner_id: OWNER_A,
          project_id: project,
          component: null,
          role: "board",
          asset_id: root.system.board.asset.assetId,
          version_id: root.system.board.asset.versionId,
        },
      ]);
    }
  }
  it.each([false, true])(
    "retains actual committed effects when COMMIT acknowledgement is lost; ROLLBACK acknowledgement lost=%s",
    async (loseRollback) => {
      fixture.hooks.afterQuery = (sql) => {
        if (sql === "COMMIT" || (loseRollback && sql === "ROLLBACK"))
          throw new Error("fixture acknowledgement lost after native SQL");
      };
      const result = await run();
      assertUncertain(result.error);
      assertEffects(observed, true);
      await assertTombstone();
      expect(fixture.events.filter((e) => e.kind === "COMMIT")).toHaveLength(1);
      expect(fixture.events.filter((e) => e.kind === "ROLLBACK")).toHaveLength(1);
    },
  );
  it.each([false, true])(
    "retains zero effects when actual COMMIT fails in a deferred SQL trigger; ROLLBACK acknowledgement lost=%s",
    async (loseRollback) => {
      await db.exec(`create function fluid_private.identity_replacement_deferred_failure() returns trigger language plpgsql set search_path='' as $fault$
      begin raise exception 'fixture_deferred_commit_failure' using errcode='PT598'; end $fault$;
      revoke all on function fluid_private.identity_replacement_deferred_failure() from public;
      create constraint trigger identity_replacement_deferred_failure after insert on public.identity_selections deferrable initially deferred for each row execute function fluid_private.identity_replacement_deferred_failure()`);
      if (loseRollback)
        fixture.hooks.afterQuery = (sql) => {
          if (sql === "ROLLBACK") throw new Error("fixture lost real ROLLBACK acknowledgement");
        };
      const result = await run();
      assertUncertain(result.error);
      assertEffects(observed, false);
      await assertTombstone();
      expect(fixture.failures).toContainEqual(expect.objectContaining({ sql: "COMMIT", code: "PT598" }));
    },
  );
  it.each([false, true])(
    "rolls back actual helper writes on pre-COMMIT abort; ROLLBACK acknowledgement lost=%s",
    async (loseRollback) => {
      const abort = controller();
      fixture.hooks.afterQuery = (sql) => {
        if (sql.includes("commit_identity_transaction")) abort.abort();
        if (loseRollback && sql === "ROLLBACK") throw new Error("fixture lost real ROLLBACK acknowledgement");
      };
      const result = await run(abort.signal);
      expect(result.error).not.toBeInstanceOf(IdentityUncertainCommitError);
      expect(result.error).toMatchObject({ code: "integration_unavailable" });
      assertDispatches();
      assertEffects(observed, false);
      await assertTombstone();
      expect(fixture.events.filter((e) => e.kind === "COMMIT")).toEqual([]);
    },
  );
  it("quarantines an abort while clean release is pending and rejects competing acquisition", async () => {
    const entered = barrier(),
      resume = barrier(),
      abort = controller();
    fixture.hooks.beforeCleanup = async () => {
      entered.resolve();
      await resume.promise;
    };
    const pending = run(abort.signal);
    await entered.promise;
    expect(fixture.inspect().phase).toBe("releasing");
    const contender = createIdentityTrustedConnectionFixture(db);
    await expect(contender.factory.acquire(OWNER_B)).rejects.toThrow("busy backend");
    expect(contender.events).toEqual([]);
    abort.abort();
    expect(fixture.inspect().phase).toBe("quarantined");
    resume.resolve();
    const result = await pending;
    assertUncertain(result.error);
    assertEffects(observed, true);
    await assertTombstone();
    expect(fixture.events.filter((e) => e.kind === "clean_handoff")).toEqual([]);
  });
  it.each([
    "residual claim",
    "residual validation",
    "residual temporary capability",
    "residual advisory lock",
    "cleanup acknowledgement",
  ])("quarantines a real cleanup verification failure: %s", async (fault) => {
    if (fault === "cleanup acknowledgement")
      fixture.hooks.afterCleanup = () => {
        throw new Error("fixture cleanup acknowledgement lost");
      };
    else
      fixture.hooks.beforeResetVerification = async () => {
        if (fault === "residual claim")
          await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_A]);
        if (fault === "residual validation")
          await db.exec("select set_config('fluid.identity.validated','true',false)");
        if (fault === "residual temporary capability")
          await db.exec("create temporary table identity_transaction_preparation(value integer)");
        if (fault === "residual advisory lock") await db.exec("select pg_advisory_lock(19876,12)");
      };
    const result = await run();
    assertUncertain(result.error);
    assertEffects(observed, true);
    await assertTombstone();
    expect(fixture.events.filter((e) => e.kind === "clean_handoff")).toEqual([]);
  });
  it("distinguishes delivery uncertainty after verified clean handoff and permits a new generation", async () => {
    const abort = controller();
    const wrapped: IdentityConnectionFactory = {
      acquire: async (...args) => {
        const lease = await fixture.factory.acquire(...args);
        return {
          ...lease,
          connection: {
            ...lease.connection,
            release: async (discard) => {
              await lease.connection.release(discard);
              observed = await snapshot(db);
              abort.abort();
            },
          },
        };
      },
    };
    const result = await run(abort.signal, wrapped);
    assertUncertain(result.error);
    assertEffects(observed, true);
    expect(fixture.inspect().phase).toBe("available");
    expect(fixture.events.filter((e) => e.kind === "clean_handoff")).toHaveLength(1);
    const newer = createIdentityTrustedConnectionFixture(db),
      lease = await newer.factory.acquire(OWNER_B);
    expect(lease.binding).toMatchObject({ ownerId: OWNER_B, roleName: "fixture_identity_replacement_b" });
    await lease.connection.release(false);
    expect(fixture.inspect().generation).toBe(2);
  });
  it("fences old abort, release, discard and query from a newer active generation", async () => {
    const entered = barrier(),
      resume = barrier(),
      oldAbort = controller(),
      newAbort = controller();
    let oldLease: Awaited<ReturnType<IdentityConnectionFactory["acquire"]>> | undefined;
    const wrapped: IdentityConnectionFactory = {
      acquire: async (...args) => {
        const lease = await fixture.factory.acquire(...args);
        oldLease = lease;
        return {
          ...lease,
          connection: {
            ...lease.connection,
            release: async (discard) => {
              await lease.connection.release(discard);
              observed = await snapshot(db);
              entered.resolve();
              await resume.promise;
            },
          },
        };
      },
    };
    const pending = run(oldAbort.signal, wrapped);
    await entered.promise;
    assertEffects(observed, true);
    const newer = createIdentityTrustedConnectionFixture(db),
      lease = await newer.factory.acquire(OWNER_B, newAbort.signal);
    const login = () =>
      lease.connection.query(
        "select session_user::text role_name,current_user::text current_name,pg_catalog.to_regrole(session_user)::oid::bigint role_oid",
      );
    expect((await login()).rows).toEqual([
      { role_name: lease.binding.roleName, current_name: lease.binding.roleName, role_oid: lease.binding.roleOid },
    ]);
    oldAbort.abort();
    await oldLease!.connection.release(true);
    await oldLease!.connection.discard();
    await expect(oldLease!.connection.query("select 1")).rejects.toThrow("stale or quarantined lease");
    expect(newer.inspect()).toMatchObject({ phase: "leased", generation: 2, poisoned: false, disposalFailed: false });
    expect((await login()).rows).toEqual([
      { role_name: lease.binding.roleName, current_name: lease.binding.roleName, role_oid: lease.binding.roleOid },
    ]);
    resume.resolve();
    assertUncertain((await pending).error);
    newAbort.abort();
    expect(newer.inspect().phase).toBe("quarantined");
    await lease.connection.release(true);
    await assertTombstone();
  });
  it("retains a shared tombstone after disposal fails without automatic retry", async () => {
    fixture.hooks.afterQuery = (sql) => {
      if (sql === "COMMIT") throw new Error("fixture lost actual COMMIT acknowledgement");
    };
    fixture.hooks.beforeDispose = async () => {
      observed = await snapshot(db);
      throw new Error("fixture physical disposal failure");
    };
    const result = await run();
    assertUncertain(result.error);
    assertEffects(observed, true);
    await assertTombstone();
    expect(fixture.inspect()).toMatchObject({ phase: "quarantined", disposalFailed: true });
    expect(db.closed).toBe(false);
  });
  it("retains a tombstone at the total disposal deadline and fences its late completion", async () => {
    const entered = barrier(),
      resume = barrier(),
      finished = barrier();
    fixture.hooks.afterQuery = (sql) => {
      if (sql === "COMMIT") throw new Error("fixture lost actual COMMIT acknowledgement");
    };
    fixture.hooks.beforeDispose = async () => {
      observed = await snapshot(db);
      entered.resolve();
      await resume.promise;
      finished.resolve();
    };
    const pending = run();
    await entered.promise;
    const result = await pending;
    assertUncertain(result.error);
    assertEffects(observed, true);
    await assertTombstone();
    expect(fixture.inspect()).toMatchObject({ phase: "quarantined", disposalFailed: true });
    expect(db.closed).toBe(false);
    const count = fixture.events.length;
    resume.resolve();
    await finished.promise;
    await Promise.resolve();
    expect(
      fixture.events.slice(count).some((event) => event.kind === "clean_handoff" || event.kind === "dispose"),
    ).toBe(false);
    await assertTombstone();
  }, 12_000);
  it.each([
    "expectedProjectRevision",
    "expectedReferenceRevision",
    "expectedPreferencesRevision",
    "expectedIdentityRevision",
  ])("rejects stale %s with zero effects", async (key) => {
    body = { ...body, [key]: Number(body[key]) + 1 };
    const result = await run();
    expect(result.error).toMatchObject({ code: "conflict" });
    expect(await snapshot(db)).toEqual(before);
    expect(fixture.events.filter((e) => e.kind === "prepare")).toHaveLength(1);
    expect(fixture.events.filter((e) => e.kind === "commit_helper")).toEqual([]);
  });
  it("rejects unknown owner and an already-aborted request before acquisition", async () => {
    const abort = controller();
    abort.abort();
    const result = await run(abort.signal);
    expect(result.error).toMatchObject({ code: "integration_unavailable" });
    await expect(fixture.factory.acquire(randomUUID())).rejects.toThrow("unknown owner");
    expect(fixture.events).toEqual([]);
    expect(await snapshot(db)).toEqual(before);
  });
});

// IR1: native prepare rows are test inputs, never intercepted service results.
// Construct the allowed proposal using shared schemas/constructors, then send
// deliberate adversarial requests directly to the real restricted commit SQL.
describe.each(["selection", "refinement"] as const)("IR1 live %s capability", (operation) => {
  let db: Database, project: string, root: Awaited<ReturnType<typeof seedIdentityRoot>>;
  let before: Awaited<ReturnType<typeof snapshot>>, prepareCalls: number, commitCalls: number;
  beforeAll(async () => {
    db = await createIdentityTrustedDatabase();
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await resetFixture(db);
    await bindIdentityFixturePrincipals(db);
    project = (await seedProject(db)).id;
    root = await seedIdentityRoot(db, project);
    before = await snapshot(db);
    prepareCalls = 0;
    commitCalls = 0;
  });
  function request() {
    const fences = {
      expectedProjectRevision: root.input.projectRevision,
      expectedReferenceRevision: root.input.referenceSnapshot.referenceRevision,
      expectedPreferencesRevision: 0,
      expectedIdentityRevision: 0,
      acceptEarlierBasis: false,
    };
    return operation === "selection"
      ? selectIdentitySystemSchema.parse({ systemVersionId: root.system.id, ...fences })
      : refineIdentityComponentSchema.parse({
          baseSystemVersionId: root.system.id,
          ...fences,
          component: "colors",
          input: {
            swatches: [{ key: "primary", name: "Native edit", hex: "#ABCDEF" }],
            usageNotes: "Live capability probe",
          },
          idempotencyKey: "live-capability-original-intent",
        });
  }
  type NativePreparation = {
    kind: string;
    ownerId: string;
    projectId: string;
    targetSystemId: string;
    principal: { sessionUserName: string; sessionUserOid: number; boundOwnerId: string };
    project: unknown;
    referenceSnapshot: unknown;
    preferences: unknown;
    session: unknown;
    previousSelection: unknown;
    now: string;
    selectionId: string;
    systemVersionId: string;
    changeId: string;
    reason: "selected" | "restored";
    proofs: { records: Array<{ system: unknown }> };
  };
  async function nativePrepare(body = request()) {
    prepareCalls++;
    return db.query<{ value: NativePreparation }>(
      "select fluid_private.prepare_identity_transaction($1::uuid,$2::jsonb,$3::boolean) value",
      [project, JSON.stringify(body), operation === "refinement"],
    );
  }
  async function nativeCommit(body: unknown, proposal: unknown, projectId = project) {
    commitCalls++;
    return db.query<{ value: unknown }>(
      "select fluid_private.commit_identity_transaction($1::uuid,$2::jsonb,$3::jsonb) value",
      [projectId, JSON.stringify(body), JSON.stringify(proposal)],
    );
  }
  async function live() {
    const body = request(),
      prepared = await nativePrepare(body);
    expect(prepared.rows).toHaveLength(1);
    const dto = prepared.rows[0]!.value;
    expect(dto).toMatchObject({ kind: "new", ownerId: OWNER_A, projectId: project, targetSystemId: root.system.id });
    const principal = (
      await db.query(
        "select session_user::text name,current_user::text current_name,to_regrole(session_user)::oid::bigint oid",
      )
    ).rows[0];
    expect(principal).toEqual({
      name: "fixture_identity_replacement_a",
      current_name: "fixture_identity_replacement_a",
      oid: dto.principal.sessionUserOid,
    });
    expect(dto.principal).toEqual({
      sessionUserName: "fixture_identity_replacement_a",
      sessionUserOid: dto.principal.sessionUserOid,
      boundOwnerId: OWNER_A,
    });
    const ownedProject = identityProjectSchema.parse(dto.project),
      session = identitySessionSchema.nullable().parse(dto.session);
    const preferences = identityPreferenceRevisionSchema.nullable().parse(dto.preferences),
      previousSelection = identitySelectionSchema.nullable().parse(dto.previousSelection);
    const target = dto.proofs.records
      .map((row) => identitySystemVersionSchema.parse(row.system))
      .find((system) => system.id === dto.targetSystemId)!;
    expect(target).toEqual(root.system);
    const currentInput = createIdentityInputSnapshot({
      ownerId: dto.ownerId,
      projectId: dto.projectId,
      scope: ownedProject.scope,
      projectRevision: ownedProject.current_revision,
      context: ownedProject.context,
      referenceSnapshot: identityReferenceSnapshotSchema.parse(dto.referenceSnapshot),
      preferencesRevision: preferences?.revision ?? 0,
      preferences: preferences?.preferences ?? initialIdentityPreferences(ownedProject.context),
      capturedAt: dto.now,
    });
    const args = {
      actorId: dto.ownerId,
      projectId: dto.projectId,
      currentInput,
      previousSelection,
      identityRevision: session?.identityRevision ?? 0,
      selectionId: dto.selectionId,
      now: dto.now,
    };
    let response: SelectIdentitySystemResponse | IdentityRefinementResponse;
    if (operation === "refinement")
      response = refineIdentityComponent({
        ...args,
        request: refineIdentityComponentSchema.parse(body),
        base: target,
        systemVersionId: dto.systemVersionId,
        changeId: dto.changeId,
      });
    else {
      const selection = selectIdentitySystem({
        ...args,
        request: selectIdentitySystemSchema.parse(body),
        system: target,
        reason: dto.reason,
      });
      response = selectIdentitySystemResponseSchema.parse({
        session: {
          ownerId: dto.ownerId,
          projectId: dto.projectId,
          identityRevision: selection.identityRevision,
          currentSelectionId: selection.id,
          currentPreferencesRevision: preferences?.revision ?? 0,
          createdAt: session?.createdAt ?? dto.now,
          updatedAt: dto.now,
        },
        currentSelection: {
          selection,
          system: target,
          freshness: getIdentityFreshness(target.input.basis, { status: "available", basis: currentInput.basis }),
        },
      });
    }
    return { body, proposal: { version: 1, kind: operation, currentInput, response } };
  }
  async function transaction(run: () => Promise<void>) {
    await asIdentityFixture(db, OWNER_A, async () => {
      await db.exec(
        "begin; set local statement_timeout='5000ms'; set local lock_timeout='1500ms'; set local idle_in_transaction_session_timeout='5000ms'",
      );
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [OWNER_A]);
      await run();
      await db.exec("commit");
    });
  }
  async function rejectAtSavepoint(run: () => Promise<unknown>, code: string) {
    await db.exec("savepoint rejection");
    await expect(run()).rejects.toMatchObject({ code });
    await db.exec("rollback to savepoint rejection");
  }
  async function singleCommit(
    response: SelectIdentitySystemResponse | IdentityRefinementResponse,
    body: ReturnType<typeof request>,
  ) {
    const state = await snapshot(db),
      refined = "system" in response;
    const selection = refined ? response.selection : response.currentSelection.selection;
    const system = refined ? response.system : response.currentSelection.system;
    const mutable = new Set([
      "identity_sessions",
      "identity_selections",
      "asset_usages",
      "assets",
      ...(refined ? ["identity_system_versions", "identity_system_files", "identity_component_changes"] : []),
    ]);
    for (const table of Object.keys(before))
      if (!mutable.has(table)) expect(state[table], table).toEqual(before[table]);
    expect(state.identity_selections).toHaveLength(1);
    expect(state.identity_sessions).toHaveLength(1);
    expect(
      (await db.query("select fluid_private.identity_selection_json(s) value from public.identity_selections s")).rows,
    ).toEqual([{ value: selection }]);
    expect(
      (await db.query("select fluid_private.identity_session_json(s) value from public.identity_sessions s")).rows,
    ).toEqual([
      {
        value: {
          ownerId: OWNER_A,
          projectId: project,
          identityRevision: 1,
          currentSelectionId: selection.id,
          currentPreferencesRevision: 0,
          createdAt: selection.createdAt,
          updatedAt: selection.createdAt,
        },
      },
    ]);
    const files = [{ component: null, role: "board", asset: system.board.asset }, ...system.productionFiles];
    expect(state.asset_usages!.slice().sort((a, b) => Number(a.slot) - Number(b.slot))).toEqual(
      files.map(({ asset }, slot) => ({
        selection_id: selection.id,
        system_id: system.id,
        slot,
        owner_id: OWNER_A,
        project_id: project,
        asset_id: asset.assetId,
        version_id: asset.versionId,
      })),
    );
    expect(state.assets).toEqual(
      before.assets!.map((asset) => ({
        ...asset,
        used: Boolean(asset.legacy_used) || files.some((file) => file.asset.assetId === asset.id),
      })),
    );
    if (refined) {
      expect(state.identity_system_versions).toHaveLength(2);
      expect(state.identity_component_changes).toHaveLength(1);
      expect(state.identity_system_versions!.filter((row) => row.id === root.system.id)).toEqual(
        before.identity_system_versions,
      );
      expect(
        (
          await db.query(
            "select fluid_private.identity_system_json(s) value from public.identity_system_versions s where id=$1",
            [system.id],
          )
        ).rows,
      ).toEqual([{ value: system }]);
      expect(
        (
          await db.query(
            "select fluid_private.identity_change_json(c) value,intent,idempotency_key from public.identity_component_changes c",
          )
        ).rows,
      ).toEqual([{ value: response.change, intent: body, idempotency_key: "live-capability-original-intent" }]);
      expect(state.identity_system_files!.filter((row) => row.system_id === root.system.id)).toEqual(
        before.identity_system_files,
      );
      expect(
        state
          .identity_system_files!.filter((row) => row.system_id === system.id)
          .sort((a, b) => Number(a.slot) - Number(b.slot)),
      ).toEqual(
        files.map(({ component, role, asset }, slot) => ({
          system_id: system.id,
          slot,
          owner_id: OWNER_A,
          project_id: project,
          component,
          role,
          asset_id: asset.assetId,
          version_id: asset.versionId,
        })),
      );
    }
  }
  it("commits a genuine proposal once and rejects the live consumed capability with no second effects", async () => {
    let accepted!: Awaited<ReturnType<typeof live>>;
    await transaction(async () => {
      accepted = await live();
      expect((await nativeCommit(accepted.body, accepted.proposal)).rows).toEqual([
        { value: accepted.proposal.response },
      ]);
      await rejectAtSavepoint(() => nativeCommit(accepted.body, accepted.proposal), "55000");
    });
    expect(prepareCalls).toBe(1);
    expect(commitCalls).toBe(2);
    await singleCommit(accepted.proposal.response, accepted.body);
  });
  it("rejects repeated prepare while its genuine live capability exists and persists no application rows", async () => {
    await transaction(async () => {
      const accepted = await live();
      await rejectAtSavepoint(() => nativePrepare(accepted.body), "PT409");
    });
    expect(prepareCalls).toBe(2);
    expect(commitCalls).toBe(0);
    expect(await snapshot(db)).toEqual(before);
  });
  it("preserves the pre-existing guard after rollback to a post-preparation savepoint", async () => {
    let accepted!: Awaited<ReturnType<typeof live>>;
    await transaction(async () => {
      accepted = await live();
      const xid = (await db.query("select pg_current_xact_id()::text xid")).rows;
      await db.exec("savepoint after_preparation; discard temp; select pg_advisory_unlock_all()");
      await expect(nativePrepare(accepted.body)).rejects.toMatchObject({ code: "PT409" });
      await db.exec("rollback to savepoint after_preparation");
      expect((await db.query("select pg_current_xact_id()::text xid")).rows).toEqual(xid);
      expect(
        (
          await db.query(
            "select exists(select 1 from pg_catalog.pg_locks where locktype='advisory' and database=(select oid from pg_catalog.pg_database where datname=current_database()) and pid=pg_backend_pid() and classid=1229214808::oid and objid=pg_backend_pid()::oid and objsubid=2 and granted) held",
          )
        ).rows,
      ).toEqual([{ held: true }]);
      await rejectAtSavepoint(() => nativePrepare(accepted.body), "PT409");
      expect((await nativeCommit(accepted.body, accepted.proposal)).rows).toEqual([
        { value: accepted.proposal.response },
      ]);
    });
    expect(prepareCalls).toBe(3);
    expect(commitCalls).toBe(1);
    await singleCommit(accepted.proposal.response, accepted.body);
  });
  it.each(["canonical request", "project", "claim", "principal"] as const)(
    "rejects changed live %s binding with zero effects",
    async (fault) => {
      await transaction(async () => {
        const accepted = await live();
        await rejectAtSavepoint(
          async () => {
            if (fault === "claim") await db.query("select set_config('request.jwt.claim.sub',$1,true)", [OWNER_B]);
            if (fault === "principal") {
              // Administrative fixture switching models a changed actual session;
              // every helper still executes as a restrictive login, never bootstrap.
              await db.exec("set session authorization fixture_identity_replacement_b");
              await db.query("select set_config('request.jwt.claim.sub',$1,true)", [OWNER_B]);
              expect((await db.query("select session_user::text session,current_user::text current")).rows).toEqual([
                { session: "fixture_identity_replacement_b", current: "fixture_identity_replacement_b" },
              ]);
            }
            return nativeCommit(
              fault === "canonical request" ? { ...accepted.body, expectedIdentityRevision: 1 } : accepted.body,
              accepted.proposal,
              fault === "project" ? randomUUID() : project,
            );
          },
          fault === "claim" ? "42501" : "55000",
        );
      });
      expect(prepareCalls).toBe(1);
      expect(commitCalls).toBe(1);
      expect(await snapshot(db)).toEqual(before);
    },
  );
  it.each(["capture time", "selection identity", "transition"] as const)(
    "rejects a schema-valid altered live %s proposal with zero effects",
    async (fault) => {
      await transaction(async () => {
        const accepted = await live(),
          altered = structuredClone(accepted.proposal);
        if (fault === "capture time")
          altered.currentInput.capturedAt = new Date(Date.parse(altered.currentInput.capturedAt) + 1_000).toISOString();
        else if (fault === "selection identity") {
          const id = randomUUID();
          if ("system" in altered.response) altered.response.selection.id = id;
          else {
            altered.response.currentSelection.selection.id = id;
            altered.response.session.currentSelectionId = id;
          }
        } else if ("system" in altered.response) {
          const palette = {
            swatches: [{ key: "primary", name: "Different valid palette", hex: "#FEDCBA" }],
            usageNotes: "Not the bound request",
          };
          altered.response.system.components.colors = palette;
          if (altered.response.change.component !== "colors") throw new Error("Unexpected direct refinement fixture");
          altered.response.change.after = palette;
        } else altered.response.currentSelection.selection.reason = "restored";
        identityInputSnapshotSchema.parse(altered.currentInput);
        if ("system" in altered.response) identityRefinementResponseSchema.parse(altered.response);
        else selectIdentitySystemResponseSchema.parse(altered.response);
        await rejectAtSavepoint(() => nativeCommit(accepted.body, altered), "55000");
      });
      expect(prepareCalls).toBe(1);
      expect(commitCalls).toBe(1);
      expect(await snapshot(db)).toEqual(before);
    },
  );
});
