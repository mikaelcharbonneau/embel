// Prepares the local test database for the browser journey: the engine login's local
// password, every generation kind switched on, the engine unpaused, and one new confirmed
// test account. Local loopback stack only (tests/journey/stack.mjs); never production.
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { journeyStack } from "./stack.mjs";

export async function prepareJourneyDatabase() {
  const stack = journeyStack();
  const client = new pg.Client({ connectionString: stack.adminDatabaseUrl });
  await client.connect();
  try {
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
