import { namingBrainJobInputSchema } from "../../src/domain/naming-brain";
import { NamingBrainJobStore, normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { OWNER_A, type TestDatabase } from "./local-supabase";
import { brainRpc, brainWorker, initialIntent, seedBrainFixture } from "./naming-brain-fixture";

export const hostedNamingMigration = "20261019024815_hosted_naming_execution.sql";

/** Operator grant in a disposable fixture only; no live connection or provider. */
export async function enableHostedNamingFixture(db: TestDatabase, enabled = true) {
 await db.query(`insert into fluid_private.hosted_naming_capabilities(owner_id,pilot_id,role_name,role_oid,deployment_id,policy_identity,enabled)
 select owner_id,id,role_name,role_oid,deployment_id,encode(sha256(convert_to(policy::text,'UTF8')),'hex'),$2
 from fluid_private.naming_brain_pilots where owner_id=$1`, [OWNER_A, enabled]);
}

export async function seedHostedNamingFixture(db: TestDatabase) {
 const project = await seedBrainFixture(db);
 await enableHostedNamingFixture(db);
 const intent = initialIntent("synthetic-hosted-initial");
 const admission = await brainRpc(db, "ensure_hosted_naming_brain_run", [project, intent]);
 const store = new NamingBrainJobStore(db, "fixture-deployment");
 const job = await brainWorker(db, () => store.claim("fixture-worker", 120));
 if (!job) throw Error("synthetic_hosted_job_missing");
 const input = namingBrainJobInputSchema.parse(normalizeNamingStoredJson(job.input));
 await brainWorker(db, () => store.registerPlan(job, [{ key: "creation", maximumCostMicrousd: 1_500_000 }, { key: "prepare", maximumCostMicrousd: 0 }]));
 await brainWorker(db, () => store.beginStep(job, "creation", 1_500_000));
 return { db, project, store, job, input, intent, admission };
}
