// The browser journey's local stack: the checkout's own Supabase (npm run dev:up), the
// stand-in OpenAI provider (fake-openai.mjs) and the app in development mode. Everything
// is on loopback and test-only. Read by playwright.journey.config.ts, the global setup
// and app-server.mjs; values are never printed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const state = path.join(root, ".embel-dev");
export const fakeProviderPort = Number(process.env.FAKE_OPENAI_PORT ?? "3176");
/** The local engine login's password. The local database is loopback-only test data. */
const ENGINE_PASSWORD = "journey-engine-local-only";

/** The shared account settings `npm run dev` passes (identity saves and Home attachments need them). */
function sharedWeb() {
  try { return parseEnv(readFileSync(path.join(state, "shared-web.env"), "utf8")); }
  catch { throw new Error("Local shared configuration is missing. Run npm run dev:up."); }
}
const SHARED_KEYS = ["EMBEL_SHARED_ACCOUNT_HTTP_ENABLED", "EMBEL_DEVELOPMENT_DATABASE_PORT", "EMBEL_SHARED_ACCOUNT_HTTP_CONFIG", "EMBEL_SHARED_LOGO_HTTP_CONFIG"];

let cached = null;
/** Local Supabase settings and keys of this checkout's stack. */
export function journeyStack() {
  if (cached) return cached;
  let settings, web;
  try {
    settings = JSON.parse(readFileSync(path.join(state, "settings.json"), "utf8"));
    web = parseEnv(readFileSync(path.join(state, "web.env"), "utf8"));
  } catch { throw new Error("No local stack for this checkout. Run npm run dev:up first."); }
  const status = JSON.parse(execFileSync(process.execPath, [path.join(root, "node_modules/supabase/dist/supabase.js"), "status", "--output", "json", "--workdir", state], {
    env: { ...process.env, SUPABASE_HOME: path.join(state, "cli-home"), SUPABASE_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "ignore"],
  }).toString());
  const apiUrl = `http://127.0.0.1:${settings.apiPort}`;
  if (status.API_URL !== apiUrl || web.NEXT_PUBLIC_SUPABASE_URL !== apiUrl || !/^sb_secret_/u.test(status.SECRET_KEY ?? "")
    || !/^postgresql:\/\/postgres:[^@]+@127\.0\.0\.1:\d+\/postgres$/u.test(status.DB_URL ?? "")) {
    throw new Error("The local stack is not the expected loopback stack. Run npm run dev:up.");
  }
  const appOrigin = `http://127.0.0.1:${settings.webPort}`;
  const shared = sharedWeb();
  if (shared.EMBEL_DEVELOPMENT_DATABASE_PORT !== String(settings.dbPort)) throw new Error("Local shared configuration is stale. Run npm run dev:up.");
  cached = {
    settings, appOrigin, apiUrl, secretKey: status.SECRET_KEY, adminDatabaseUrl: status.DB_URL, enginePassword: ENGINE_PASSWORD,
    fakeProviderOrigin: `http://127.0.0.1:${fakeProviderPort}`,
    /** The app server's environment (development mode: the app accepts loopback http only there). */
    appEnvironment: {
      ...Object.fromEntries(SHARED_KEYS.filter(key => Object.hasOwn(shared, key)).map(key => [key, shared[key]])),
      NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", PORT: String(settings.webPort),
      EMBEL_DEVELOPMENT_ENABLED: "true", APP_ORIGIN: appOrigin,
      NEXT_PUBLIC_SUPABASE_URL: apiUrl, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: web.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      EMBEL_ENGINE_DATABASE_URL: `postgres://embel_engine:${ENGINE_PASSWORD}@127.0.0.1:${settings.dbPort}/postgres`,
      EMBEL_ENGINE_SUPABASE_SECRET_KEY: status.SECRET_KEY,
      // The stand-in provider; a real key is never needed or sent anywhere.
      OPENAI_API_KEY: "sk-journey-fake-provider-0000000000",
      EMBEL_OPENAI_BASE_URL: `http://127.0.0.1:${fakeProviderPort}`,
      WORKFLOW_LOCAL_DATA_DIR: path.join(state, "journey-workflow-data"),
      WORKFLOW_LOCAL_BASE_URL: appOrigin,
    },
  };
  return cached;
}
