import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  defaults,
  digest,
  prepare,
  publicEnvironment,
  readOptional,
  settingsFor,
} from "../../scripts/development/config.mjs";
import { localDockerEnvironment, main, parseArguments } from "../../scripts/development.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
async function checkout(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "embel checkout with spaces "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "supabase/migrations"), { recursive: true });
  await mkdir(path.join(root, "config/development"), { recursive: true });
  await writeFile(
    path.join(root, "config/development/supabase.toml"),
    await readFile(path.join(repository, "config/development/supabase.toml")),
  );
  await writeFile(
    path.join(root, "supabase/migrations/local20260101000000_first.sql"),
    "-- original bytes\r\nselect 1;\r\n",
  );
  await writeFile(path.join(root, "supabase/migrations/20260102000000_second.sql"), "select 'unchanged';\n");
  return root;
}

test("a fresh checkout with spaces stages ordered exact SQL and is repeatable without outside files", async (t) => {
  const root = await checkout(t);
  const first = await prepare(root);
  const second = await prepare(root);
  assert.deepEqual(first.settings, second.settings);
  assert.deepEqual(
    first.migrations.map((x) => x.staged),
    ["20260101000000_first.sql", "20260102000000_second.sql"],
  );
  for (const entry of first.migrations) {
    const original = await readFile(path.join(root, "supabase/migrations", entry.source));
    assert.deepEqual(await readFile(path.join(first.state, "supabase/migrations", entry.staged)), original);
    assert.equal(entry.sha256, digest(original));
  }
  const config = await readFile(path.join(first.state, "supabase/config.toml"), "utf8");
  assert.ok(!config.includes("{{"));
  assert.ok(config.includes("enable_confirmations = true"));
  assert.ok(!config.includes("/workspace"));
});

test("setup cannot silently replace changed or removed migration history", async (t) => {
  const root = await checkout(t);
  const first = await prepare(root);
  const file = path.join(first.state, "supabase/migrations/20260101000000_first.sql");
  await writeFile(file, "select 'local change';");
  await assert.rejects(prepare(root), /staged migration differs/);
  assert.equal(await readFile(file, "utf8"), "select 'local change';");
  await writeFile(file, first.migrations[0].bytes);
  await rm(path.join(root, "supabase/migrations/20260102000000_second.sql"));
  await assert.rejects(prepare(root), /different migration history/);
});

test("duplicate migration versions fail before staging ambiguous SQL", async (t) => {
  const root = await checkout(t);
  await writeFile(path.join(root, "supabase/migrations/20260101000000_collision.sql"), "select 2;");
  await assert.rejects(prepare(root), /duplicate version/);
});

test("generated web settings cannot contain private CLI fields or point to a remote project", async () => {
  const settings = { version: 1, projectId: "embel-dev-123456789abc", ...defaults };
  const status = {
    API_URL: "http://127.0.0.1:54321",
    PUBLISHABLE_KEY: "sb_publishable_local",
    SERVICE_ROLE_KEY: "private-service-sentinel",
    SECRET_KEY: "private-secret-sentinel",
    DB_URL: "postgres://private-db-sentinel",
  };
  const env = publicEnvironment(settings, status);
  assert.ok(env.includes("sb_publishable_local"));
  assert.ok(!env.includes("private-"));
  assert.throws(
    () => publicEnvironment(settings, { ...status, API_URL: "https://example.supabase.co" }),
    /unexpected local URL/,
  );
  assert.throws(
    () => publicEnvironment(settings, { ...status, PUBLISHABLE_KEY: "sb_secret_not_public" }),
    /publishable key/,
  );
  assert.throws(
    () => publicEnvironment(settings, { ...status, PUBLISHABLE_KEY: "sb_publishable_ok\nINJECTED=true" }),
    /publishable key/,
  );
});

test("changing ports invalidates the old public target until up refreshes it", async (t) => {
  const root = await checkout(t);
  const { state, settings } = await prepare(root);
  await writeFile(
    path.join(state, "web.env"),
    publicEnvironment(settings, { API_URL: "http://127.0.0.1:54321", PUBLISHABLE_KEY: "sb_publishable_local" }),
  );
  await main(["setup", "--web-port", "3155", "--api-port", "55421"], root);
  const env = await readFile(path.join(state, "web.env"), "utf8");
  assert.ok(env.includes("APP_ORIGIN=http://127.0.0.1:3155"));
  assert.ok(env.includes("EMBEL_DEVELOPMENT_ENABLED=false"));
  assert.ok(!env.includes("sb_publishable_local"));
  assert.equal((await settingsFor(root)).apiPort, 55421);
  await assert.rejects(prepare(root, { apiPort: 3155 }), /distinct integers/);
});

test("doctor does not create state in an unprepared checkout", async (t) => {
  const root = await checkout(t);
  const before = await readdir(root);
  await assert.rejects(main(["doctor"], root), /dev:setup/);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readOptional(path.join(root, ".embel-dev/settings.json")), null);
});

test(
  "managed state refuses symlinks instead of writing through them",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await checkout(t);
    const outside = await mkdtemp(path.join(os.tmpdir(), "embel-outside-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await symlink(outside, path.join(root, ".embel-dev"));
    await assert.rejects(prepare(root), /real directory/);
    assert.deepEqual(await readdir(outside), []);
  },
);

test("Docker target remains local and keeps proxy, trust and registry selectors", () => {
  const env = {
    DOCKER_CONTEXT: "old",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CONFIG: "registry-selector",
    HTTPS_PROXY: "proxy-selector",
    NODE_EXTRA_CA_CERTS: "trust-selector",
  };
  assert.throws(() => localDockerEnvironment("ssh://remote", env), /remote Docker/);
  assert.throws(() => localDockerEnvironment("npipe:////remote-host/pipe/docker_engine", env), /remote Docker/);
  assert.throws(() => localDockerEnvironment("tcp://192.0.2.1:2375", env), /remote Docker/);
  const local = localDockerEnvironment("unix:///var/run/docker.sock", env);
  assert.equal(local.DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(local.DOCKER_CONTEXT, undefined);
  assert.equal(local.DOCKER_CONFIG, env.DOCKER_CONFIG);
  assert.equal(local.HTTPS_PROXY, env.HTTPS_PROXY);
  assert.equal(local.NODE_EXTRA_CA_CERTS, env.NODE_EXTRA_CA_CERTS);
  assert.equal(
    localDockerEnvironment("npipe:////./pipe/docker_engine", env).DOCKER_HOST,
    "npipe:////./pipe/docker_engine",
  );
});

test("only explicit supported local command options are accepted", () => {
  assert.equal(parseArguments(["up", "--proxy-health", "--api-port", "55421"]).ports.apiPort, 55421);
  for (const args of [["reset"], ["up", "--linked"], ["up", "--api-port", "remote"], ["doctor", "--db-port", "55422"]])
    assert.throws(() => parseArguments(args));
});
