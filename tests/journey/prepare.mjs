// Prepares the local test database for the browser journey: the engine login's local
// password, every generation kind switched on, the engine unpaused, and one new confirmed
// test account. Local loopback stack only (tests/journey/stack.mjs); never production.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { journeyStack, root } from "./stack.mjs";

// npm run dev:up applies every migration first and installs the reviewed shared packets and
// the shared HTTP logins afterwards. Two migration blocks depend on what those add, so on a
// freshly built local stack they do nothing; production ran them after the packets. Each is
// replayed exactly as written (both are idempotent):
// - 20261110140000_naming_engine widens name_candidates_check1 only once the brainstorm origin
//   exists; without it the packet's older check refuses every engine name;
// - 20261110160000_harden_database_api grants the job_steps policy helpers to every existing
//   login; the shared HTTP logins are created later, so choosing a Creative direction fails.
const REPLAYS = [
  { migration: "20261110140000_naming_engine.sql", block: /do \$origin\$[\s\S]*?end \$origin\$;/u },
  { migration: "20261110160000_harden_database_api.sql", block: /do \$\$\ndeclare r record;[\s\S]*?end \$\$;/u },
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
