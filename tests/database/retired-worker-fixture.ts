import { randomUUID } from "node:crypto";
import type { TestDatabase } from "./local-supabase";

// Rows the retired worker functions used to write, written directly as the database owner.
// Fixture setup only: the job states of begin_job_step, complete_job_step and finish_job for
// API-billed jobs, and a finished Naming batch as enqueue_subscription_naming_job and
// complete_naming_job_step left it.
type LeasedJob = { id: string; lease_token: string };

/** A finished, published Naming batch with generated names, in the project's current revision.
 * The project must have saved Naming preferences. */
export async function seedGeneratedNames(
  db: TestDatabase,
  owner: string,
  project: string,
  names: readonly string[],
  model = "fixture-model",
) {
  const policy = { model };
  const jobId = randomUUID(),
    batchId = randomUUID(),
    key = `fixture-generated-${batchId}`;
  const revision = (
    await db.query<{ revision: number; input_hash: string; basis: unknown }>(
      "select r.revision, r.input_hash, fluid_private.naming_strategy_basis(r.context) basis from public.projects p join public.project_revisions r on r.project_id = p.id and r.revision = p.current_revision where p.id = $1 and p.owner_id = $2",
      [project, owner],
    )
  ).rows[0]!;
  const preferences = (
    await db.query<{ version: number }>(
      "select max(version) version from public.naming_preferences where project_id = $1",
      [project],
    )
  ).rows[0]!.version;
  await db.query(
    `insert into public.jobs(id, owner_id, project_id, operation, input_revision, input_hash, input, idempotency_key, reserved_cost_microusd, max_attempts, billing_mode, policy_identity, state, progress, attempts, finished_at)
    values ($1, $2, $3, 'naming.generate', $4, $5, $6::jsonb, $7, 0, 1, 'chatgpt_subscription', encode(sha256(convert_to(($6::jsonb->'policy')::text, 'UTF8')), 'hex'), 'succeeded', 100, 1, clock_timestamp())`,
    [
      jobId,
      owner,
      project,
      revision.revision,
      revision.input_hash,
      JSON.stringify({ billingMode: "chatgpt_subscription", operation: "naming.generate", policy }),
      key,
    ],
  );
  const sequence = (
    await db.query<{ next: number }>(
      "select coalesce(max(sequence), 0) + 1 next from public.naming_batches where project_id = $1",
      [project],
    )
  ).rows[0]!.next;
  const target = sequence === 1 ? 250 : 50;
  await db.query(
    `insert into public.naming_batches(id, owner_id, project_id, sequence, context_revision, strategy_basis, preferences_version, favorites_snapshot, exclusion_keys, policy_identity, target_count, job_id, idempotency_key)
    select $1, $2, $3, $4, $5, $6::jsonb, $7, '[]', '[]', policy_identity, $8, id, $9 from public.jobs where id = $10`,
    [
      batchId,
      owner,
      project,
      sequence,
      revision.revision,
      JSON.stringify(revision.basis),
      preferences,
      target,
      key,
      jobId,
    ],
  );
  await db.query(
    "update public.naming_sessions set batch_sequence = $2, revision = revision + 1, updated_at = clock_timestamp() where project_id = $1",
    [project, sequence],
  );
  const ids: string[] = [];
  for (const value of names) {
    const id = randomUUID();
    const origin = {
      kind: "generated",
      ownerId: owner,
      projectId: project,
      candidateId: id,
      contextRevision: revision.revision,
      value,
      batchId,
      jobId,
      stepKey: "names",
      provider: "openai",
      billingMode: "chatgpt_subscription",
      model,
      responseId: "fixture-response",
      requestId: null,
      generatedAt: "2026-10-04T12:00:00Z",
    };
    await db.query(
      `insert into public.name_candidates(id, owner_id, project_id, value, identity_key, context_revision, strategy_basis, origin, rationale, batch_id, created_at)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'Explicit local fixture.', $9, clock_timestamp())`,
      [
        id,
        owner,
        project,
        value,
        value.toLowerCase(),
        revision.revision,
        JSON.stringify(revision.basis),
        JSON.stringify(origin),
        batchId,
      ],
    );
    ids.push(id);
  }
  const fulfillment = {
    status: ids.length === target ? "complete" : ids.length === 0 ? "none" : "partial",
    targetCount: target,
    acceptedCount: ids.length,
    rejections: {
      invalid_candidate: 0,
      empty_identity: 0,
      below_minimum: 0,
      above_maximum: 0,
      duplicate_response: 0,
      duplicate_history: 0,
      over_target: 0,
    },
    message: ids.length === target ? null : `${ids.length} / ${target} accepted names. No additional request was made.`,
  };
  const output = {
    version: 1,
    operation: "naming.generate",
    provider: "openai",
    billingMode: "chatgpt_subscription",
    model,
    responseId: "fixture-response",
    requestId: null,
    generatedAt: "2026-10-04T12:00:00Z",
    usage: null,
    batchId,
    sequence,
    targetCount: target,
    accepted: names.map((value) => ({ value, identityKey: value.toLowerCase(), rationale: "Explicit local fixture." })),
    fulfillment,
  };
  await db.query(
    "insert into public.job_steps(job_id, owner_id, project_id, step_key, request_key, state, reserved_cost_microusd, output, provider_request_id, completed_at) values ($1, $2, $3, 'names', 'fixture-request', 'succeeded', 0, $4::jsonb, 'fixture-response', clock_timestamp())",
    [jobId, owner, project, JSON.stringify(output)],
  );
  await db.query(
    "insert into public.naming_batch_results(batch_id, owner_id, project_id, result, completion_input) values ($1, $2, $3, $4::jsonb, $5::jsonb)",
    [
      batchId,
      owner,
      project,
      JSON.stringify({
        ownerId: owner,
        projectId: project,
        batchId,
        jobId,
        stepKey: "names",
        candidateIds: ids,
        fulfillment,
        completedAt: new Date().toISOString(),
      }),
      JSON.stringify(output),
    ],
  );
  return { batchId, jobId, ids };
}

async function leased(db: TestDatabase, job: LeasedJob) {
  const row = (
    await db.query<{ owner_id: string; state: string }>(
      "select owner_id, state from public.jobs where id = $1 and lease_token = $2",
      [job.id, job.lease_token],
    )
  ).rows[0];
  if (!row) throw new Error("job fixture: lease not held");
  return row;
}

/** Starts a planned step (in flight, with its reserved cost). */
export async function beginStep(
  db: TestDatabase,
  job: LeasedJob,
  key: string,
  requestKey: string,
  maximumCostMicrousd: number,
) {
  if ((await leased(db, job)).state !== "running") throw new Error("job fixture: job is not running");
  return (
    await db.query(
      "insert into public.job_steps(job_id, owner_id, project_id, step_key, request_key, state, reserved_cost_microusd) select id, owner_id, project_id, $2, $3, 'in_flight', $4 from public.jobs where id = $1 returning *",
      [job.id, key, requestKey, maximumCostMicrousd],
    )
  ).rows[0]!;
}

/** Records a step's outcome and real cost, capturing it from the job's reservation. An ambiguous
 * outcome or a cost overrun moves the job to needs_reconciliation. */
export async function completeStep(
  db: TestDatabase,
  job: LeasedJob,
  key: string,
  outcome: "succeeded" | "failed" | "ambiguous",
  costMicrousd: number,
  output: unknown = null,
  providerRequestId: string | null = null,
) {
  const { owner_id: owner } = await leased(db, job);
  const step = (
    await db.query<{ reserved_cost_microusd: number }>(
      "update public.job_steps set state = $3, actual_cost_microusd = $4, output = $5::jsonb, provider_request_id = $6, completed_at = clock_timestamp() where job_id = $1 and step_key = $2 and state = 'in_flight' returning reserved_cost_microusd",
      [job.id, key, outcome, costMicrousd, output === null ? null : JSON.stringify(output), providerRequestId],
    )
  ).rows[0];
  if (!step) throw new Error("job fixture: step is not in flight");
  const captured = (
    await db.query<{ captured: number }>(
      "select least(greatest(reserved_microusd - actual_microusd, 0), $2::bigint)::int captured from public.usage_reservations where job_id = $1",
      [job.id, costMicrousd],
    )
  ).rows[0]!.captured;
  await db.query(
    "update public.usage_accounts set spent_microusd = spent_microusd + $2, provider_actual_microusd = provider_actual_microusd + $3, reserved_microusd = reserved_microusd - $2 where owner_id = $1",
    [owner, captured, costMicrousd],
  );
  await db.query(
    "update public.usage_reservations set actual_microusd = actual_microusd + $2, captured_microusd = captured_microusd + $3 where job_id = $1",
    [job.id, costMicrousd, captured],
  );
  await db.query("update public.jobs set actual_cost_microusd = actual_cost_microusd + $2 where id = $1", [
    job.id,
    costMicrousd,
  ]);
  if (outcome === "ambiguous" || costMicrousd > Number(step.reserved_cost_microusd)) {
    await db.query(
      "update public.jobs set state = 'needs_reconciliation', lease_token = null, lease_expires_at = null, error_code = $2 where id = $1",
      [job.id, outcome === "ambiguous" ? "provider_outcome_unknown" : "cost_overrun"],
    );
  }
}

/** Ends a leased job and settles its reservation. */
export async function finishJob(
  db: TestDatabase,
  job: LeasedJob,
  state: "succeeded" | "failed" | "partial" | "cancelled",
) {
  await leased(db, job);
  await db.query("select fluid_private.settle_reservation($1)", [job.id]);
  await db.query(
    "update public.jobs set state = $2, progress = case when $2 = 'succeeded' then 100 else progress end, lease_token = null, lease_expires_at = null, finished_at = clock_timestamp() where id = $1",
    [job.id, state],
  );
}
