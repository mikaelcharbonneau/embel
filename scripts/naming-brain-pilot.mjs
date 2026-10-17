#!/usr/bin/env node
/** Opt-in runner. Never invoke against a real account without separate execution approval.
 * Run with Node's --import tsx; no credential files, grants, funding or provider calls are created here.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { accountProjectResponseSchema, accountSessionSchema } from "../src/domain/project-api.ts";
import { ensureNamingRunIntentSchema, namingBrainRunResponseSchema, namingFeedEnsureResultSchema, namingFeedResponseSchema } from "../src/domain/naming-brain.ts";
import { getNamingPreferencesReadiness } from "../src/domain/naming-brain-preferences.ts";
import { projectNamingOverviewSchema } from "../src/domain/naming-jobs.ts";

const hash = z.string().regex(/^[0-9a-f]{64}$/), money = z.number().int().nonnegative().max(25_000_000);
const configSchema = z.strictObject({ version: z.literal(1), origin: z.string().url(), ownerId: z.uuid(), projectId: z.uuid(), sourceRevision: z.string().regex(/^[0-9a-f]{40}$/), migrationSha256: hash, policyIdentity: hash,
  approval: z.strictObject({ executionAuthorized: z.literal(true), fundingAuthorized: z.literal(true), activationReadbackVerified: z.literal(true), exactOriginAndRevisionVerified: z.literal(true), approvedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), maxNewRuns: z.literal(1), aggregateCeilingMicrousd: z.literal(25_000_000), runAllowanceMicrousd: z.literal(5_000_000) }),
  accounting: z.strictObject({ observedAt: z.iso.datetime(), completeOwnerInventoryVerified: z.literal(true), noUnknownDispatchOrOverrunVerified: z.literal(true), aggregateCommittedMicrousd: money, runs: z.array(z.strictObject({ projectId: z.uuid(), runId: z.uuid() })).max(500) }),
  intent: ensureNamingRunIntentSchema,
});
export class PilotRefusal extends Error { constructor(code) { super(`Naming pilot stopped: ${code}`); this.code = code; } }
function stop(code) { throw new PilotRefusal(code); }
export function validatePilotConfiguration(raw, { executionApproved = false, now = Date.now() } = {}) {
  if (!executionApproved) stop("explicit_execution_approval_required");
  const parsed = configSchema.safeParse(raw); if (!parsed.success) stop("invalid_approval_configuration");
  const value = parsed.data, origin = new URL(value.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || origin.origin !== value.origin) stop("exact_https_origin_required");
  const approved = Date.parse(value.approval.approvedAt), expiry = Date.parse(value.approval.expiresAt), observed = Date.parse(value.accounting.observedAt);
  if (approved > now || expiry <= now || expiry - approved > 3_600_000 || now - observed > 600_000 || observed > now) stop("stale_approval_or_accounting");
  if (value.intent.reason === "scroll") stop("automatic_continuation_not_authorized");
  if (new Set(value.accounting.runs.map(run => run.runId)).size !== value.accounting.runs.length) stop("duplicate_accounting_inventory");
  if (value.accounting.aggregateCommittedMicrousd + 5_000_000 > 25_000_000) stop("aggregate_allowance_exhausted");
  return value;
}
export async function runNamingPilot(raw, options = {}) {
  const config = validatePilotConfiguration(raw, options), fetcher = options.fetch ?? globalThis.fetch;
  const cookie = options.cookie;
  if (typeof cookie !== "string" || !cookie || /[\r\n]/.test(cookie)) stop("ephemeral_authenticated_session_required");
  // This credential is sent only to the approved exact origin; redirects are never followed.
  async function request(path, schema, body) {
    const target = new URL(path, config.origin);
    if (target.origin !== config.origin || !path.startsWith("/api/") || path.includes("?")) stop("unexpected_request_target");
    let response;
    try { response = await fetcher(target.href, { method: body ? "POST" : "GET", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15_000), headers: { Cookie: cookie, Accept: "application/json", ...(body ? { "Content-Type": "application/json", Origin: config.origin, "X-Embel-Account": config.ownerId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { stop(body ? "admission_outcome_unknown_keep_exact_intent" : "preflight_read_unavailable"); }
    if (response.redirected || response.url && response.url !== target.href || response.status >= 300 && response.status < 400) stop("redirect_or_origin_mismatch");
    if (!response.ok) stop(body ? "admission_not_confirmed_keep_exact_intent" : "preflight_read_rejected");
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) stop("invalid_receipt_type");
    // Bound private responses; neither their text nor provider error bodies are ever logged.
    const reader = response.body?.getReader(); if (!reader) stop("missing_receipt");
    const chunks = []; let length = 0;
    try { while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > 2_000_000) { await reader.cancel(); stop("receipt_too_large"); } chunks.push(next.value); } }
    catch (error) { if (error instanceof PilotRefusal) throw error; stop(body ? "admission_outcome_unknown_keep_exact_intent" : "preflight_read_unavailable"); }
    let data; try { const raw = Buffer.concat(chunks).toString("utf8"); data = schema.safeParse(JSON.parse(raw)); } catch { stop("invalid_receipt"); }
    if (!data.success) stop("invalid_receipt");
    return data.data;
  }
  const { user } = await request("/api/session", accountSessionSchema);
  if (user.id !== config.ownerId) stop("authenticated_owner_mismatch");
  const { project } = await request(`/api/projects/${config.projectId}`, accountProjectResponseSchema);
  if (project.owner_id !== config.ownerId || project.id !== config.projectId || project.scope === "visual_identity_only") stop("owned_project_mismatch");
  const overview = await request(`/api/projects/${config.projectId}/naming`, projectNamingOverviewSchema);
  if (overview.project.owner_id !== config.ownerId || overview.project.id !== config.projectId || !overview.readiness.ready || overview.preferences?.preferences.version !== 2 || !getNamingPreferencesReadiness(overview.preferences.preferences).ready) stop("saved_choices_not_ready");
  let total = 0;
  for (const reference of config.accounting.runs) {
    const { run } = await request(`/api/projects/${reference.projectId}/naming/runs/${reference.runId}`, namingBrainRunResponseSchema);
    if (run.ownerId !== config.ownerId || run.projectId !== reference.projectId || run.runId !== reference.runId) stop("accounting_owner_or_run_mismatch");
    if (["needs_reconciliation", "queued", "running", "cancel_requested"].includes(run.state)) stop("prior_execution_requires_resolution");
    total += run.accounting.status === "held_unsettled" ? run.accounting.heldAllowanceMicrousd : run.accounting.confirmedActualCostMicrousd;
  }
  if (total !== config.accounting.aggregateCommittedMicrousd || total + 5_000_000 > 25_000_000) stop("aggregate_accounting_mismatch");
  const { feed } = await request(`/api/projects/${config.projectId}/naming/feed`, namingFeedResponseSchema);
  const intent = config.intent;
  if (feed.ownerId !== config.ownerId || feed.projectId !== config.projectId || feed.availability.status !== "available" || feed.availability.acceptedPolicyIdentity !== config.policyIdentity || feed.state === "blocked") stop("readiness_or_policy_mismatch");
  if (feed.projectRevision !== project.current_revision || feed.projectRevision !== intent.expectedProjectRevision || feed.preferencesVersion !== overview.preferences.version || feed.preferencesVersion !== intent.expectedPreferencesVersion || feed.steeringRevision !== intent.expectedSteeringRevision || feed.demandSequence !== intent.expectedDemandSequence) stop("saved_basis_changed");
  if (feed.activeRun && !config.accounting.runs.some(run => run.runId === feed.activeRun.runId)) stop("incomplete_accounting_inventory");
  if (intent.reason === "initial" && (feed.activeRun || feed.entries.length || feed.paused)) stop("initial_run_requires_fresh_exploration");
  if (intent.reason === "resume" && (!feed.activeRun?.canResume || feed.activeRun.runId !== intent.resumeOfRunId || feed.activeRun.revision !== intent.expectedRunRevision || ["needs_reconciliation", "queued", "running", "cancel_requested"].includes(feed.activeRun.state))) stop("resume_not_qualified");
  validatePilotConfiguration(config, { ...options, now: options.now ?? Date.now() });
  // One explicit operation only. SQL remains authoritative for concurrent admissions and reservation.
  // On any lost response the caller retains this exact intent; this runner never creates another key.
  const result = await request(`/api/projects/${config.projectId}/naming/feed/ensure`, namingFeedEnsureResultSchema, intent);
  if (result.feed.ownerId !== config.ownerId || result.feed.projectId !== config.projectId) stop("admission_owner_mismatch_keep_exact_intent");
  if (result.status === "blocked" || result.status === "paused") return { status: result.status, action: result.action, newRunRequested: false, finalCharge: null };
  const run = "run" in result ? result.run : result.feed.activeRun;
  if (!run || run.acceptedPolicyIdentity !== config.policyIdentity || run.ownerId !== config.ownerId || run.projectId !== config.projectId || run.projectRevision !== intent.expectedProjectRevision || run.preferencesVersion !== intent.expectedPreferencesVersion || run.steeringRevision !== intent.expectedSteeringRevision) stop("admission_basis_mismatch_keep_exact_intent");
  if (intent.reason === "resume" && run.resumedFromRunId !== intent.resumeOfRunId && run.runId !== intent.resumeOfRunId) stop("resume_link_mismatch_keep_exact_intent");
  return { status: result.status, runId: run.runId, jobId: run.jobId, accounting: run.accounting, uniqueNamesInReceipt: new Set(result.feed.entries.map(row => row.entry.candidate.identityKey)).size, finalCharge: run.accounting.confirmedActualCostMicrousd };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Require both the command-line action and a short-lived, separately approved receipt file.
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--execute-approved-pilot") stop("explicit_execution_approval_required");
    const raw = JSON.parse(await readFile(process.argv[3], "utf8"));
    const result = await runNamingPilot(raw, { executionApproved: true, cookie: process.env.EMBEL_NAMING_PILOT_COOKIE });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error instanceof PilotRefusal ? error.message : "Naming pilot stopped: invalid_configuration_or_internal_failure"}\n`); process.exitCode = 1; }
}
