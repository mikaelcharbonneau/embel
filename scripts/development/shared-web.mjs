import path from "node:path";
import { DevelopmentError, readOptional, writeState } from "./config.mjs";

export async function prepareSharedWeb(root, settings) {
  const raw = await readOptional(path.join(root, ".embel-dev/shared/provisioning.json"));
  if (!raw) throw new DevelopmentError("Shared database provisioning is missing; run npm run dev:up.");
  const provision = JSON.parse(raw);
  const target = provision.target;
  if (target?.deploymentId !== settings.projectId || target?.applicationOrigin !== `http://127.0.0.1:${settings.webPort}` || target?.supabaseOrigin !== `http://127.0.0.1:${settings.apiPort}`
    || target?.databaseHost !== "127.0.0.1" || target?.databasePort !== settings.dbPort) throw new DevelopmentError("Shared database settings are stale; run npm run dev:up.");
  const principal = lane => {
    const found = provision.httpPrincipals?.filter(row => row.lane === lane);
    if (found?.length !== 1) throw new DevelopmentError("Shared HTTP principal is missing.");
    const { roleName, roleOid, databaseUrl } = found[0];
    const url = new URL(databaseUrl);
    if (url.hostname !== "127.0.0.1" || Number(url.port) !== settings.dbPort || decodeURIComponent(url.username) !== roleName) throw new DevelopmentError("Shared HTTP database target differs from local settings.");
    return { roleName, roleOid, databaseUrl };
  };
  const values = {
    EMBEL_SHARED_ACCOUNT_HTTP_ENABLED: "true",
    EMBEL_DEVELOPMENT_DATABASE_PORT: String(settings.dbPort),
    EMBEL_SHARED_ACCOUNT_HTTP_CONFIG: JSON.stringify({ identity: principal("identity"), homeVerifier: principal("home") }),
    EMBEL_SHARED_LOGO_HTTP_CONFIG: JSON.stringify(principal("logo")),
  };
  // JSON is valid inside dotenv single quotes; generated passwords contain no quotes.
  if (Object.values(values).some(value => /['\r\n]/.test(value))) throw new DevelopmentError("Invalid generated HTTP configuration.");
  await writeState(path.join(root, ".embel-dev/shared-web.env"), Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n");
  return { sharedHttpReady: true };
}

export async function sharedWebEnvironment(root, settings, publicValues) {
  const raw = await readOptional(path.join(root, ".embel-dev/shared-web.env"));
  if (!raw) return {};
  const { parseEnv } = await import("node:util");
  const values = parseEnv(raw);
  if (publicValues.EMBEL_DEVELOPMENT_ENABLED !== "true" || values.EMBEL_DEVELOPMENT_DATABASE_PORT !== String(settings.dbPort)) throw new DevelopmentError("Local shared configuration is stale; run npm run dev:up.");
  const provision = JSON.parse(await readOptional(path.join(root, ".embel-dev/shared/provisioning.json")) ?? "null");
  if (provision?.target?.deploymentId !== settings.projectId || provision?.target?.applicationOrigin !== `http://127.0.0.1:${settings.webPort}`
    || provision?.target?.supabaseOrigin !== `http://127.0.0.1:${settings.apiPort}` || provision?.target?.databaseHost !== "127.0.0.1"
    || provision?.target?.databasePort !== settings.dbPort || publicValues.APP_ORIGIN !== provision.target.applicationOrigin
    || publicValues.NEXT_PUBLIC_SUPABASE_URL !== provision.target.supabaseOrigin) throw new DevelopmentError("Local shared configuration is stale; run npm run dev:up.");
  const account = JSON.parse(values.EMBEL_SHARED_ACCOUNT_HTTP_CONFIG ?? "null");
  const logo = JSON.parse(values.EMBEL_SHARED_LOGO_HTTP_CONFIG ?? "null");
  for (const [lane, actual] of [["identity", account?.identity], ["home", account?.homeVerifier], ["logo", logo]]) {
    const rows = provision.httpPrincipals?.filter(row => row.lane === lane);
    if (rows?.length !== 1 || !actual || ["roleName", "roleOid", "databaseUrl"].some(key => actual[key] !== rows[0][key])) throw new DevelopmentError("Shared HTTP bindings differ from local provisioning.");
  }
  const keys = ["EMBEL_SHARED_ACCOUNT_HTTP_ENABLED", "EMBEL_DEVELOPMENT_DATABASE_PORT", "EMBEL_SHARED_ACCOUNT_HTTP_CONFIG", "EMBEL_SHARED_LOGO_HTTP_CONFIG"];
  return Object.fromEntries(keys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]));
}
