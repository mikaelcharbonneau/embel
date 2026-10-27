import "server-only";
import { assertSharedPoolAttestation, readSharedPoolConfiguration, type SharedPoolAttestation } from "./configuration";
import { createSharedSlotPool, type SharedSlotPool } from "./database";
import { readSharedPoolSecrets } from "./secrets";

/** Does not construct an engine, claim/renew/fence a slot, sign in to Storage,
 * instantiate Queue or call a provider. Each pool qualifies in READ ONLY and
 * rolls back before close. This is a prerequisite check, not active readiness. */
export async function preflightSharedPool(env: Readonly<Record<string, string | undefined>>, attestation: SharedPoolAttestation,
  dependencies: { createPool?: typeof createSharedSlotPool } = {}) {
  const config = readSharedPoolConfiguration(env);
  if (!config) throw Error("shared_pool_preflight_disabled");
  assertSharedPoolAttestation(config, attestation);
  const secrets = readSharedPoolSecrets(config, env);
  const qualified: string[] = [];
  for (const slot of config.slots) {
    const pool: SharedSlotPool = (dependencies.createPool ?? createSharedSlotPool)(config, slot, secrets.slots[slot.slotId]!);
    try { await pool.qualify(); qualified.push(slot.slotId); } finally { await pool.close(); }
  }
  return { version: 1 as const, event: "shared_worker_pool_preflight_passed" as const,
    mode: "read_only" as const, activationReady: false as const,
    sourceRevision: attestation.sourceRevision, artifactSha256: attestation.artifactSha256,
    deploymentId: config.target.deploymentId, qualifiedSlotIds: qualified,
    checked: ["artifact", "runtime", "target", "finite_secret_shapes", "database_tls_and_role", "source_owned_sql_catalog", "registered_capacity"],
    unchecked: ["slot_deployment_and_policy_binding", "queue_access", "provider_access", "storage_session", "active_job_execution"] };
}
