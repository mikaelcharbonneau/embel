import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));

async function checkout(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "embel launcher with spaces ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["scripts/development", ".embel-dev", "node_modules/tsx", "node_modules/next/dist/bin"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const file of ["scripts/development-web.mjs", "scripts/development/config.mjs", "scripts/development/shared-web.mjs"]) {
    await copyFile(path.join(repository, file), path.join(root, file));
  }
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  // Execute the real launcher, with tiny child programs instead of starting
  // Next.js. No installed-package symlinks are required.
  await writeFile(path.join(root, "node_modules/tsx/package.json"), '{"name":"tsx","type":"module","exports":"./index.mjs"}\n');
  await writeFile(path.join(root, "node_modules/tsx/index.mjs"), 'import { register } from "node:module"; register("./loader.mjs", import.meta.url);\n');
  await writeFile(path.join(root, "node_modules/tsx/loader.mjs"), `
export async function load(url, context, nextLoad) {
  return nextLoad(url, context);
}
`);
  await writeFile(path.join(root, "node_modules/next/package.json"), '{"name":"next","type":"module"}\n');
  await writeFile(path.join(root, ".embel-dev/settings.json"), JSON.stringify({
    version: 1, projectId: "embel-dev-123456789abc", webPort: 3155,
    apiPort: 55421, dbPort: 55422, shadowPort: 55420, mailPort: 55424,
  }));
  await writeFile(path.join(root, ".env.development.local"), "APP_ORIGIN=http://127.0.0.1:1111\nEMBEL_DEVELOPMENT_PROVIDER_API_KEY=fixture-local\n");
  await writeFile(path.join(root, ".embel-dev/strategy.env"), "EMBEL_DEVELOPMENT_PROVIDER_API_KEY=fixture-lane\nEMBEL_DEVELOPMENT_DISPATCH_APPROVED=true\nFLUID_PAID_CALLS_APPROVED=true\n");
  await writeFile(path.join(root, ".embel-dev/web.env"), "EMBEL_DEVELOPMENT_ENABLED=true\nAPP_ORIGIN=http://127.0.0.1:3155\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55421\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_fixture\nFLUID_PAID_CALLS_APPROVED=false\nEMBEL_DEVELOPMENT_PROVIDER_API_KEY=fixture-managed-ignored\n");
  return root;
}

function environment(overrides = {}) {
  const result = { ...process.env };
  for (const key of Object.keys(result)) {
    if (/^(?:EMBEL_|NEXT_PUBLIC_SUPABASE_|VERCEL(?:_|$))/.test(key)
      || ["APP_ORIGIN", "NODE_ENV", "FLUID_PAID_CALLS_APPROVED", "FIXTURE_EXIT_CODE"].includes(key)) delete result[key];
  }
  return { ...result, APP_ORIGIN: "https://fixture.invalid", NODE_ENV: "production", ...overrides };
}

async function run(root, launcher, args, env = environment()) {
  try {
    const result = await execute(process.execPath, [path.join(root, "scripts", launcher), ...args], {
      cwd: os.tmpdir(), env, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("web launcher uses its generated origin and configured port from any working directory", async t => {
  const root = await checkout(t);
  await writeFile(path.join(root, "node_modules/next/dist/bin/next"), `
console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2),
  origin: process.env.APP_ORIGIN, supabase: process.env.NEXT_PUBLIC_SUPABASE_URL,
  mode: process.env.NODE_ENV,
  managedCredentialIgnored: process.env.EMBEL_DEVELOPMENT_PROVIDER_API_KEY === undefined }));
`);
  const result = await run(root, "development-web.mjs", ["--webpack"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: root, args: ["dev", "--hostname", "127.0.0.1", "--port", "3155", "--webpack"],
    origin: "http://127.0.0.1:3155", supabase: "http://127.0.0.1:55421",
    mode: "development", managedCredentialIgnored: true,
  });
});

test("web launcher rejects URL overrides and hosted markers before spawning Next.js", async t => {
  const root = await checkout(t);
  for (const args of [["--port=9000"], ["-p", "9000"], ["--hostname", "0.0.0.0"]]) {
    const result = await run(root, "development-web.mjs", args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /dev:setup/);
  }
  const hosted = await run(root, "development-web.mjs", [], environment({ VERCEL_ENV: "production" }));
  assert.equal(hosted.code, 1);
  assert.equal(hosted.stdout, "");
  assert.match(hosted.stderr, /without hosted Vercel markers/);
});
