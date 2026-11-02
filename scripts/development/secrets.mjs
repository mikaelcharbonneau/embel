#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { DevelopmentError, privateDirectory, readOptional, repositoryRoot, writeState } from "./config.mjs";

export const providerKeyName = "EMBEL_DEVELOPMENT_PROVIDER_API_KEY";
const projectId = "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt";
const teamId = "team_0Koie5796IDOraQkDFg6J0AF";

export async function developmentProviderKey(root, environment = process.env) {
  const file = await readOptional(path.join(root, ".embel-dev/provider.env"));
  const value = environment[providerKeyName] || (file ? parseEnv(file)[providerKeyName] : undefined);
  if (value !== undefined && (!value.trim() || /[\s'"\r\n]/.test(value))) throw new DevelopmentError("The dedicated development provider credential is invalid.");
  return value;
}

export async function syncDevelopmentSecret(action, root = repositoryRoot, environment = process.env, fetcher = fetch) {
  if (!["pull", "push"].includes(action)) throw new DevelopmentError("Use npm run dev:secrets -- pull or push. Only the dedicated development provider key is synchronized.");
  if (!environment.VERCEL_TOKEN) throw new DevelopmentError("Configure VERCEL_TOKEN securely for this shell to access the team's development secrets.");
  const headers = { Authorization: `Bearer ${environment.VERCEL_TOKEN}`, "Content-Type": "application/json" };
  let response;
  if (action === "pull") {
    response = await fetcher(`https://api.vercel.com/v10/projects/${projectId}/env?teamId=${teamId}&decrypt=false`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new DevelopmentError(`Development secret download failed (HTTP ${response.status}); no local credential was changed.`);
    const data = await response.json();
    const candidates = data.envs?.filter(row => row.key === providerKeyName && row.target?.includes("development") && !row.gitBranch && !row.customEnvironmentIds?.length);
    if (candidates?.length !== 1 || candidates[0].target.some(target => target !== "development")) throw new DevelopmentError("The central dedicated development key is missing or has ambiguous environment targets.");
    if (typeof candidates[0].id !== "string" || !/^[A-Za-z0-9_-]+$/.test(candidates[0].id)) throw new DevelopmentError("The central development key has no valid binding identifier.");
    response = await fetcher(`https://api.vercel.com/v1/projects/${projectId}/env/${candidates[0].id}?teamId=${teamId}`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new DevelopmentError(`Development key retrieval failed (HTTP ${response.status}).`);
    const selected = await response.json();
    if (selected.key !== providerKeyName || !Array.isArray(selected.target) || selected.target.length !== 1 || selected.target[0] !== "development" || selected.gitBranch || selected.customEnvironmentIds?.length) throw new DevelopmentError("The retrieved credential does not belong exclusively to development.");
    const value = selected.value;
    if (typeof value !== "string" || !value || /[\s'"\r\n]/.test(value)) throw new DevelopmentError("The central development key is unavailable; no local credential was changed.");
    await privateDirectory(path.join(root, ".embel-dev"));
    await writeState(path.join(root, ".embel-dev/provider.env"), `${providerKeyName}=${value}\n`);
  } else {
    const value = await developmentProviderKey(root, environment);
    if (!value) throw new DevelopmentError("No dedicated development provider key is configured to publish.");
    const metadata = await fetcher(`https://api.vercel.com/v10/projects/${projectId}/env?teamId=${teamId}&decrypt=false`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!metadata.ok) throw new DevelopmentError(`Development secret scope check failed (HTTP ${metadata.status}).`);
    const existing = (await metadata.json()).envs?.filter(row => row.key === providerKeyName);
    if (!Array.isArray(existing) || existing.some(row => row.target?.length !== 1 || row.target[0] !== "development" || row.gitBranch || row.customEnvironmentIds?.length)) throw new DevelopmentError("An existing binding uses another environment; no credential was uploaded.");
    response = await fetcher(`https://api.vercel.com/v10/projects/${projectId}/env?teamId=${teamId}&upsert=true`, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(30_000), body: JSON.stringify({ key: providerKeyName, value, type: "encrypted", target: ["development"], comment: "Embel local/Codex development provider credential; never a production binding." }) });
    if (!response.ok) throw new DevelopmentError(`Development secret upload failed (HTTP ${response.status}).`);
  }
  return { action, key: providerKeyName, environment: "development", file: ".embel-dev/provider.env" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await syncDevelopmentSecret(process.argv[2]), null, 2)); }
  catch (error) { console.error(error instanceof DevelopmentError ? error.message : "Development secret synchronization failed; private details withheld."); process.exitCode = 1; }
}
