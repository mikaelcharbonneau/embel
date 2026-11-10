// Prepares the local test database for the browser journey: the engine login's local
// password, every generation kind switched on, the engine unpaused, and one new confirmed
// test account. Local loopback stack only (tests/journey/stack.mjs); never production.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { journeyStack, root } from "./stack.mjs";

// npm run dev:up installs the reviewed shared packets just before the migration that retires
// the old worker objects (20261110180000), so a few earlier migrations ran before them. One
// block of those depends on what the packets add, so on a freshly built local stack it did
// nothing; production ran it after the packets. It is replayed exactly as written (idempotent):
// - 20261110140000_naming_engine widens name_candidates_check1 only once the brainstorm origin
//   exists; without it the packet's older check refuses every engine name.
// 20261110160000_harden_database_api's grants of the job_steps policy helpers were replayed
// too; 20261110180000 dropped those policies, so nothing needs the grants any more.
const REPLAYS = [
  { migration: "20261110140000_naming_engine.sql", block: /do \$origin\$[\s\S]*?end \$origin\$;/u },
];

export async function prepareJourneyDatabase() {
  const stack = journeyStack();
  const client = new pg.Client({ connectionString: stack.adminDatabaseUrl });
  await client.connect();
  try {
    for (const replay of REPLAYS) {
      const source = await readFile(path.join(root, "supabase/migrations", replay.migration), "utf8");
      const block = replay.block.exec(source);
      if (!block) throw new Error(`Migration ${replay.migration} changed; update tests/journey/prepare.mjs.`);
      await client.query(block[0]);
    }
    await client.query(`alter role embel_engine password '${stack.enginePassword}'`);
    await client.query("update fluid_private.generation_kinds set enabled = true");
    await client.query("update fluid_private.engine_settings set paused = false");
  } finally { await client.end(); }
}

/** A new confirmed account, created with the local stack's secret key. */
export async function createJourneyAccount() {
  const stack = journeyStack();
  const admin = createClient(stack.apiUrl, stack.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `journey-${randomBytes(4).toString("hex")}@example.test`, password = randomBytes(18).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`Could not create the journey test account: ${error?.message ?? "no user"}`);
  return { email, password, userId: data.user.id };
}
