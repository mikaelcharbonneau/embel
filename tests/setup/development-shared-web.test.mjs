import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareSharedWeb, sharedWebEnvironment } from "../../scripts/development/shared-web.mjs";

const settings = { projectId: "embel-dev-123456789abc", webPort: 3155, apiPort: 55421, dbPort: 55422 };
const publicValues = { EMBEL_DEVELOPMENT_ENABLED: "true", APP_ORIGIN: "http://127.0.0.1:3155", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55421" };
async function checkout(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "embel shared web "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".embel-dev/shared"), { recursive: true });
  const provision = { version: 1, target: { deploymentId: settings.projectId, applicationOrigin: publicValues.APP_ORIGIN, supabaseOrigin: publicValues.NEXT_PUBLIC_SUPABASE_URL, databaseHost: "127.0.0.1", databasePort: settings.dbPort },
    httpPrincipals: ["identity", "home", "logo"].map((lane, index) => ({ lane, roleName: `embel_shared_http_${lane}_test`, roleOid: 12000 + index, databaseUrl: `postgresql://embel_shared_http_${lane}_test:inert-private-password@127.0.0.1:55422/postgres?sslmode=disable` })) };
  const save = async value => writeFile(path.join(root, ".embel-dev/shared/provisioning.json"), JSON.stringify(value));
  await save(provision);
  return { root, provision, save };
}

test("shared web uses distinct restricted principals in a private dotenv file without provider credentials", async t => {
  const { root } = await checkout(t);
  assert.deepEqual(await prepareSharedWeb(root, settings), { sharedHttpReady: true });
  const env = await sharedWebEnvironment(root, settings, publicValues);
  const account = JSON.parse(env.EMBEL_SHARED_ACCOUNT_HTTP_CONFIG), logo = JSON.parse(env.EMBEL_SHARED_LOGO_HTTP_CONFIG);
  assert.equal(env.EMBEL_SHARED_WORKERS_ENABLED, "true");
  assert.equal(env.EMBEL_DEVELOPMENT_DATABASE_PORT, "55422");
  assert.match(account.identity.roleName, /identity/u);
  assert.match(account.homeVerifier.roleName, /home/u);
  assert.match(logo.roleName, /logo/u);
  assert.equal(Object.keys(env).length, 5);
  assert.equal((await stat(path.join(root, ".embel-dev/shared-web.env"))).mode & 0o777, 0o600);
  await writeFile(path.join(root, ".embel-dev/shared-web.env"), await readFile(path.join(root, ".embel-dev/shared-web.env"), "utf8") + "OPENAI_API_KEY=inert-provider-not-web\nNEXT_PUBLIC_UNEXPECTED=inert-ignored\n");
  const projected = await sharedWebEnvironment(root, settings, publicValues);
  assert.ok(!JSON.stringify(projected).includes("inert-provider"));
  assert.ok(!Object.hasOwn(projected, "NEXT_PUBLIC_UNEXPECTED"));
});

test("changed checkout, API, web or database ports reject stale shared bindings before launch", async t => {
  const { root } = await checkout(t);
  await prepareSharedWeb(root, settings);
  for (const changes of [{ projectId: "embel-dev-fedcba987654" }, { webPort: 3156 }, { apiPort: 55431 }, { dbPort: 55432 }]) {
    await assert.rejects(sharedWebEnvironment(root, { ...settings, ...changes }, publicValues), /stale/u);
    await assert.rejects(prepareSharedWeb(root, { ...settings, ...changes }), /stale/u);
  }
  for (const changes of [{ EMBEL_DEVELOPMENT_ENABLED: "false" }, { APP_ORIGIN: "https://www.embel.xyz" }, { NEXT_PUBLIC_SUPABASE_URL: "https://fricsfwqibyhemknqgyf.supabase.co" }]) {
    await assert.rejects(sharedWebEnvironment(root, settings, { ...publicValues, ...changes }), /stale/u);
  }
});

test("web configuration cannot silently reuse a rotated, foreign or duplicated principal", async t => {
  const { root, provision, save } = await checkout(t);
  await prepareSharedWeb(root, settings);
  for (const modify of [value => { value.httpPrincipals[0].roleOid++; }, value => { value.httpPrincipals[0].databaseUrl = value.httpPrincipals[0].databaseUrl.replace("inert-private-password", "inert-rotated-password"); }, value => { value.httpPrincipals.push(value.httpPrincipals[0]); }]) {
    const changed = structuredClone(provision); modify(changed); await save(changed);
    await assert.rejects(sharedWebEnvironment(root, settings, publicValues), /bindings/u);
  }
  const remote = structuredClone(provision); remote.httpPrincipals[0].databaseUrl = remote.httpPrincipals[0].databaseUrl.replace("127.0.0.1", "example.com"); await save(remote);
  await assert.rejects(prepareSharedWeb(root, settings), /target/u);
});

test("a checkout without a shared dotenv file has no shared credentials", async t => {
  const { root } = await checkout(t);
  assert.deepEqual(await sharedWebEnvironment(root, settings, publicValues), {});
});
