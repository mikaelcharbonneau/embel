import { randomUUID } from "node:crypto";
import type { TestDatabase } from "../../database/local-supabase";
import type { IdentityConnectionFactory } from "../../../src/server/data/identity-transaction";

/** Injected local PGlite capability ONLY, not a deployed role/helper implementation.
 * SQL reads/writes occur in the transaction owned by the real service, while
 * callbacks here instrument fixed DB stages. No credentials or provider work. */
export function createIdentityTransactionFixture(db: TestDatabase, owner: string) {
  const events: string[] = [],
    releases: boolean[] = [];
  const hooks: {
    prepare?: (value: Record<string, unknown>) => void;
    stage?: (stage: string) => void;
    commitAcknowledgment?: "lost_before" | "lost_after";
    rollbackFailure?: boolean;
    releaseFailure?: boolean;
    receipt?: (value: Record<string, unknown>) => void;
  } = {};
  let prepared: Record<string, unknown> | undefined;
  const binding = { ownerId: owner, roleName: "postgres", roleOid: 10 };
  async function queryValue(sql: string, parameters: unknown[] = []) {
    return (await db.query<{ value: unknown }>(sql, parameters)).rows[0]!.value;
  }
  async function proof(project: string) {
    const records: Array<Record<string, unknown>> = [],
      roots: Array<Record<string, unknown>> = [],
      rootSources: Array<Record<string, unknown>> = [],
      files: Array<Record<string, unknown>> = [],
      batches: Array<Record<string, unknown>> = [];
    const systems = (
      await db.query<{ id: string; root_system_id: string; base_system_id: string | null; change_id: string | null }>(
        "select id,root_system_id,base_system_id,change_id from public.identity_system_versions where owner_id=$1 and project_id=$2 order by id",
        [owner, project],
      )
    ).rows;
    const jobIds = (
      await db.query<{ job_id: string }>(
        "select distinct job_id from public.identity_generated_roots where owner_id=$1 and project_id=$2 order by job_id",
        [owner, project],
      )
    ).rows.map((row) => row.job_id);
    for (const id of jobIds)
      await db.query("select id from public.jobs where id=$1 and owner_id=$2 for share", [id, owner]);
    for (const id of jobIds)
      await db.query(
        "select step_key from public.job_steps where job_id=$1 and owner_id=$2 order by step_key for share",
        [id, owner],
      );
    for (const row of systems) {
      const system = (await queryValue(
        "select fluid_private.identity_system_json(s) value from public.identity_system_versions s where id=$1",
        [row.id],
      )) as { id: string; input: { preferences: unknown }; source: { kind: string } };
      const change = row.change_id
        ? await queryValue(
            "select fluid_private.identity_change_json(c) value from public.identity_component_changes c where id=$1",
            [row.change_id],
          )
        : null;
      const selection = row.change_id
        ? await queryValue(
            "select fluid_private.identity_selection_json(s) value from public.identity_selections s join public.identity_component_changes c on c.selection_id=s.id where c.id=$1",
            [row.change_id],
          )
        : null;
      records.push({ system, rootSystemId: row.root_system_id, base: row.base_system_id, change, selection });
      files.push(
        ...(
          await db.query<{ value: Record<string, unknown> }>(
            "select jsonb_build_object('systemVersionId',f.system_id,'slot',f.slot,'component',f.component,'role',f.role,'asset',jsonb_build_object('ownerId',a.owner_id,'projectId',a.project_id,'assetId',a.id,'versionId',v.id,'contentHash',v.content_hash,'purpose',a.purpose,'mimeType',v.mime_type)) value from public.identity_system_files f join public.assets a on a.id=f.asset_id join public.asset_versions v on v.id=f.version_id where f.system_id=$1 order by f.slot",
            [row.id],
          )
        ).rows.map((row) => row.value),
      );
      if (system.source.kind !== "generated") continue;
      const root = (
        await db.query<{
          batch_id: string;
          job_id: string;
          step_key: string;
          output_index: number;
          board: unknown;
          input_id: string;
        }>(
          "select r.*,b.input_id from public.identity_generated_roots r join public.identity_batches b on b.id=r.batch_id where r.system_id=$1",
          [row.id],
        )
      ).rows[0]!;
      const input = await queryValue("select input value from public.identity_input_snapshots where id=$1", [
        root.input_id,
      ]);
      const batch = {
        id: root.batch_id,
        ownerId: owner,
        projectId: project,
        jobId: root.job_id,
        targetCount: 3,
        input,
      };
      const step = await queryValue(
        "select jsonb_build_object('ownerId',owner_id,'projectId',project_id,'jobId',job_id,'stepKey',step_key,'state',state,'completedAt',completed_at,'output',output) value from public.job_steps where job_id=$1 and step_key=$2",
        [root.job_id, root.step_key],
      );
      roots.push({
        batch,
        step,
        receipt: {
          version: 1,
          ownerId: owner,
          projectId: project,
          batchId: root.batch_id,
          jobId: root.job_id,
          stepKey: root.step_key,
          outputIndex: root.output_index,
          systemVersionId: row.id,
          board: root.board,
        },
        system,
      });
      rootSources.push(
        (await queryValue(
          "select jsonb_build_object('systemVersionId',$1::uuid,'job',jsonb_build_object('id',j.id,'ownerId',j.owner_id,'projectId',j.project_id,'operation',j.operation,'inputRevision',j.input_revision),'context',r.context,'referenceSnapshot',s.snapshot,'preferencesRevision',coalesce(i.preferences_revision,0),'preferences',coalesce(p.preferences,jsonb_build_object('version',1,'creativeLocale',coalesce(r.context->>'creativeLocale','en'),'notes',coalesce(r.context#>>'{intake,identityNotes}',''),'avoidanceNotes',''))) value from public.identity_input_snapshots i join public.project_revisions r on r.project_id=i.project_id and r.owner_id=i.owner_id and r.revision=i.project_revision join public.identity_reference_snapshots s on s.project_id=i.project_id and s.owner_id=i.owner_id and s.reference_revision=i.reference_revision join public.jobs j on j.id=$2 left join public.identity_preferences p on p.project_id=i.project_id and p.owner_id=i.owner_id and p.revision=i.preferences_revision where i.id=$3",
          [row.id, root.job_id, root.input_id],
        )) as Record<string, unknown>,
      );
    }
    batches.push(
      ...(
        await db.query<{ value: Record<string, unknown> }>(
          "select jsonb_build_object('batchId',batch_id,'acceptedRootCount',count(*)) value from public.identity_generated_roots where owner_id=$1 and project_id=$2 group by batch_id order by batch_id",
          [owner, project],
        )
      ).rows.map((row) => row.value),
    );
    return { records, roots, rootSources, files, batches };
  }
  async function prepare(project: string, request: Record<string, unknown>, refinement: boolean) {
    events.push("prepare");
    const projectRow = await db.query("select id from public.projects where id=$1 and owner_id=$2 for update", [
      project,
      owner,
    ]);
    if (!projectRow.rows.length) throw { code: "P0002" };
    await db.query(
      "select project_id from public.identity_reference_heads where project_id=$1 and owner_id=$2 for update",
      [project, owner],
    );
    await db.query("select project_id from public.identity_sessions where project_id=$1 and owner_id=$2 for update", [
      project,
      owner,
    ]);
    const oid = (await db.query<{ oid: number }>("select oid::int from pg_roles where rolname=session_user")).rows[0]!
      .oid;
    const principal = { sessionUserName: "postgres", sessionUserOid: oid, boundOwnerId: owner };
    const proofs = await proof(project);
    if (refinement) {
      const replay = (
        await db.query<{ intent: unknown; result_system_id: string; id: string; selection_id: string }>(
          "select intent,result_system_id,id,selection_id from public.identity_component_changes where project_id=$1 and owner_id=$2 and idempotency_key=$3",
          [project, owner, request.idempotencyKey],
        )
      ).rows[0];
      if (replay)
        return {
          version: 1,
          kind: "replay",
          principal,
          projectId: project,
          ownerId: owner,
          proofs,
          intent: replay.intent,
          response: {
            system: await queryValue(
              "select fluid_private.identity_system_json(s) value from public.identity_system_versions s where id=$1",
              [replay.result_system_id],
            ),
            change: await queryValue(
              "select fluid_private.identity_change_json(c) value from public.identity_component_changes c where id=$1",
              [replay.id],
            ),
            selection: await queryValue(
              "select fluid_private.identity_selection_json(s) value from public.identity_selections s where id=$1",
              [replay.selection_id],
            ),
          },
        };
    }
    const now = (await queryValue("select to_jsonb(clock_timestamp()) value")) as string;
    const state = (await queryValue("select fluid_private.identity_current_state($1) value", [project])) as {
      project: unknown;
      session: { currentSelectionId: string | null } | null;
      preferences: unknown;
      referenceSnapshot: unknown;
    };
    const previousSelection = state.session?.currentSelectionId
      ? await queryValue(
          "select fluid_private.identity_selection_json(s) value from public.identity_selections s where id=$1",
          [state.session.currentSelectionId],
        )
      : null;
    // The final lock class follows all mutable source reads/locks.
    await db.query("select id from public.assets where project_id=$1 and owner_id=$2 order by id for update", [
      project,
      owner,
    ]);
    return {
      version: 1,
      kind: "new",
      principal,
      projectId: project,
      ownerId: owner,
      proofs,
      project: state.project,
      session: state.session,
      preferences: state.preferences,
      referenceSnapshot: state.referenceSnapshot,
      previousSelection,
      targetSystemId: request[refinement ? "baseSystemVersionId" : "systemVersionId"],
      selectionId: randomUUID(),
      systemVersionId: randomUUID(),
      changeId: randomUUID(),
      now,
      reason: (
        await db.query("select id from public.identity_selections where system_id=$1 and owner_id=$2", [
          request.systemVersionId,
          owner,
        ])
      ).rows.length
        ? "restored"
        : "selected",
    };
  }
  // What the retired fluid_private.identity_write_selection did: revision checks, the
  // selection, its asset usages, the session head and the assets' used flags.
  async function writeSelection(
    project: string,
    systemId: string,
    state: Record<string, unknown>,
    accept: boolean,
    reason: string,
    id: string,
    at: unknown,
  ) {
    const check = (
      await db.query<{ stale: boolean; behind: boolean; previous_id: string | null; previous_conflict: boolean }>(
        `
      with s as (select v.*,fluid_private.identity_system_json(v)->'input' input from public.identity_system_versions v where v.id=$1 and v.project_id=$2 and v.owner_id=$3),
        p as (select * from public.identity_selections where id=($4::jsonb->>'previousSelectionId')::uuid and project_id=$2 and owner_id=$3)
      select s.input->'basis'<>$4::jsonb->'currentBasis' stale,
        ($4::jsonb->>'projectRevision')::bigint<coalesce((s.source->>'editedAtProjectRevision')::bigint,(s.input->>'projectRevision')::bigint)
          or ($4::jsonb->>'referenceRevision')::bigint<coalesce((s.source->>'editedAtReferenceRevision')::bigint,(s.input#>>'{referenceSnapshot,referenceRevision}')::bigint)
          or ($4::jsonb->>'preferencesRevision')::bigint<coalesce((s.source->>'editedAtPreferencesRevision')::bigint,(s.input->>'preferencesRevision')::bigint) behind,
        p.id previous_id,
        coalesce(p.identity_revision<>($4::jsonb->>'identityRevision')::bigint or p.project_revision>($4::jsonb->>'projectRevision')::bigint
          or p.reference_revision>($4::jsonb->>'referenceRevision')::bigint or coalesce(p.preferences_revision,0)>($4::jsonb->>'preferencesRevision')::bigint,false) previous_conflict
      from s left join p on true`,
        [systemId, project, owner, JSON.stringify(state)],
      )
    ).rows[0];
    if (!check) throw { code: "P0002" };
    if (check.behind || check.previous_conflict || (check.stale && !accept)) throw { code: "PT409" };
    await db.query(
      "select id from public.assets where owner_id=$1 and project_id=$2 and (id in (select asset_id from public.asset_usages where selection_id=$3) or id in (select asset_id from public.identity_system_files where system_id=$4)) order by id for update",
      [owner, project, check.previous_id, systemId],
    );
    await db.query(
      `insert into public.identity_selections(id,project_id,owner_id,system_id,identity_revision,project_revision,reference_revision,preferences_revision,current_basis,accepted_earlier_basis,previous_selection_id,reason,created_at)
      values($1,$2,$3,$4,($5::jsonb->>'identityRevision')::bigint+1,($5::jsonb->>'projectRevision')::integer,($5::jsonb->>'referenceRevision')::bigint,nullif(($5::jsonb->>'preferencesRevision')::bigint,0),$5::jsonb->'currentBasis',$6,$7,$8,$9)`,
      [id, project, owner, systemId, JSON.stringify(state), check.stale, check.previous_id, reason, at],
    );
    await db.query(
      "insert into public.asset_usages(selection_id,system_id,slot,project_id,owner_id,asset_id,version_id) select $1,system_id,slot,project_id,owner_id,asset_id,version_id from public.identity_system_files where system_id=$2 and project_id=$3 and owner_id=$4",
      [id, systemId, project, owner],
    );
    await db.query(
      "update public.identity_sessions set identity_revision=s.identity_revision,current_selection_id=s.id,updated_at=s.created_at from public.identity_selections s where s.id=$1 and identity_sessions.project_id=$2 and identity_sessions.owner_id=$3",
      [id, project, owner],
    );
    await db.query(
      `update public.assets a set used=(a.legacy_used or exists(select 1 from public.asset_usages u join public.identity_sessions h on h.current_selection_id=u.selection_id and h.project_id=u.project_id and h.owner_id=u.owner_id where u.asset_id=a.id and u.project_id=a.project_id and u.owner_id=a.owner_id))
      where a.owner_id=$1 and a.project_id=$2 and (a.id in (select asset_id from public.asset_usages where selection_id=$3) or a.id in (select asset_id from public.asset_usages where selection_id=$4))`,
      [owner, project, check.previous_id, id],
    );
  }
  async function commit(
    project: string,
    request: Record<string, unknown>,
    proposal: { kind: string; currentInput: Record<string, unknown>; response: Record<string, unknown> },
  ) {
    events.push("commit_helper");
    hooks.stage?.("before_write");
    const input = proposal.currentInput,
      response = proposal.response;
    await db.query(
      "insert into public.identity_sessions(project_id,owner_id,created_at,updated_at) values($1,$2,$3,$3) on conflict do nothing",
      [project, owner, prepared!.now],
    );
    hooks.stage?.("session");
    await db.query("select fluid_private.capture_identity_reference_snapshot($1,$2)", [
      project,
      request.expectedReferenceRevision,
    ]);
    hooks.stage?.("snapshot");
    const state = {
      projectRevision: request.expectedProjectRevision,
      referenceRevision: request.expectedReferenceRevision,
      preferencesRevision: request.expectedPreferencesRevision,
      identityRevision: request.expectedIdentityRevision,
      currentBasis: input.basis,
      previousSelectionId: (prepared!.previousSelection as { id: string } | null)?.id ?? null,
    };
    let systemId: string, selection: { id: string; reason: string };
    if (proposal.kind === "refinement") {
      const system = response.system as {
        id: string;
        source: { baseSystemVersionId: string; changeId: string; component: string };
        components: unknown;
        board: unknown;
        productionFiles: Array<{ component: string; role: string; asset: { assetId: string; versionId: string } }>;
      };
      selection = response.selection as typeof selection;
      systemId = system.id;
      await db.query(
        "insert into public.identity_system_versions(id,project_id,owner_id,input_id,root_system_id,base_system_id,change_id,source,components,board,production_files,created_at,created_at_text) select $1,$2,$3,input_id,root_system_id,id,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::text::timestamptz,$9::text from public.identity_system_versions where id=$10 and project_id=$2 and owner_id=$3",
        [
          system.id,
          project,
          owner,
          system.source.changeId,
          JSON.stringify(system.source),
          JSON.stringify(system.components),
          JSON.stringify(system.board),
          JSON.stringify(system.productionFiles),
          prepared!.now,
          system.source.baseSystemVersionId,
        ],
      );
      hooks.stage?.("system");
      await db.query(
        "insert into public.identity_system_files(system_id,slot,project_id,owner_id,component,role,asset_id,version_id) select $1,0,project_id,owner_id,component,role,asset_id,version_id from public.identity_system_files where system_id=$2 and slot=0",
        [system.id, system.source.baseSystemVersionId],
      );
      for (const [index, file] of system.productionFiles.entries())
        await db.query(
          "insert into public.identity_system_files(system_id,slot,project_id,owner_id,component,role,asset_id,version_id) values($1,$2,$3,$4,$5,$6,$7,$8)",
          [system.id, index + 1, project, owner, file.component, file.role, file.asset.assetId, file.asset.versionId],
        );
      hooks.stage?.("files");
    } else {
      const current = response.currentSelection as { system: { id: string }; selection: typeof selection };
      systemId = current.system.id;
      selection = current.selection;
    }
    await writeSelection(
      project,
      systemId,
      state,
      request.acceptEarlierBasis === true,
      selection.reason,
      selection.id,
      prepared!.now,
    );
    hooks.stage?.("selection_and_usage");
    if (proposal.kind === "refinement") {
      const change = response.change as {
        id: string;
        baseSystemVersionId: string;
        component: string;
        before: unknown;
        after: unknown;
        currentBasis: unknown;
        acceptedEarlierBasis: boolean;
      };
      await db.query(
        "insert into public.identity_component_changes(id,project_id,owner_id,base_system_id,result_system_id,selection_id,component,before_value,after_value,project_revision,reference_revision,preferences_revision,current_basis,accepted_earlier_basis,idempotency_key,intent,created_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,nullif($12,0),$13::jsonb,$14,$15,$16::jsonb,$17)",
        [
          change.id,
          project,
          owner,
          change.baseSystemVersionId,
          systemId,
          selection.id,
          change.component,
          JSON.stringify(change.before),
          JSON.stringify(change.after),
          request.expectedProjectRevision,
          request.expectedReferenceRevision,
          request.expectedPreferencesRevision,
          JSON.stringify(change.currentBasis),
          change.acceptedEarlierBasis,
          request.idempotencyKey,
          JSON.stringify(request),
          prepared!.now,
        ],
      );
      hooks.stage?.("change");
    }
    hooks.stage?.("receipt");
    hooks.receipt?.(response);
    return response;
  }
  const factory: IdentityConnectionFactory = {
    async acquire() {
      events.push("acquire");
      const oid = (await db.query<{ oid: number }>("select oid::int from pg_roles where rolname=session_user")).rows[0]!
        .oid;
      binding.roleOid = oid;
      return {
        binding,
        connection: {
          async query(sql, parameters = []) {
            events.push(sql.startsWith("SELECT fluid_private.") ? sql.split("(")[0]! : sql);
            if (sql.includes("prepare_identity_transaction")) {
              prepared = await prepare(
                String(parameters[0]),
                JSON.parse(String(parameters[1])),
                parameters[2] === true,
              );
              hooks.prepare?.(prepared);
              return { rows: [{ value: prepared }] };
            }
            if (sql.includes("commit_identity_transaction"))
              return {
                rows: [
                  {
                    value: await commit(
                      String(parameters[0]),
                      JSON.parse(String(parameters[1])),
                      JSON.parse(String(parameters[2])),
                    ),
                  },
                ],
              };
            if (sql === "COMMIT" && hooks.commitAcknowledgment === "lost_before")
              throw new Error("fixture COMMIT acknowledgment lost");
            if (sql === "COMMIT" && hooks.commitAcknowledgment === "lost_after") {
              await db.exec("COMMIT");
              throw new Error("fixture COMMIT acknowledgment lost");
            }
            if (sql === "ROLLBACK" && hooks.rollbackFailure) {
              await db.exec("ROLLBACK");
              throw new Error("fixture rollback acknowledgment lost");
            }
            return db.query(sql, [...parameters]);
          },
          release(discard) {
            events.push("release");
            releases.push(discard);
            if (hooks.releaseFailure) throw new Error("fixture release failed");
          },
          discard() {
            events.push("discard");
          },
        },
      };
    },
  };
  return { factory, events, releases, hooks, binding };
}
