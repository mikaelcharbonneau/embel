import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { developmentProviderKey, providerKeyName, syncDevelopmentSecret } from "../../scripts/development/secrets.mjs";

async function checkout(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "embel secrets "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".embel-dev"));
  return root;
}
const secret = "inert-dedicated-development-secret";
const metadata = { id: "env_development", key: providerKeyName, target: ["development"] };

test("application credentials come only from the dedicated input, never ambient agent or production keys", async (t) => {
  const root = await checkout(t);
  assert.equal(
    await developmentProviderKey(root, { OPENAI_API_KEY: "inert-agent", API_KEY: "inert-other" }),
    undefined,
  );
  await writeFile(
    path.join(root, ".embel-dev/provider.env"),
    `OPENAI_API_KEY=inert-file-agent\n${providerKeyName}=${secret}\n`,
  );
  assert.equal(await developmentProviderKey(root, { OPENAI_API_KEY: "inert-agent" }), secret);
  assert.equal(
    await developmentProviderKey(root, { [providerKeyName]: "inert-explicit-development" }),
    "inert-explicit-development",
  );
  await assert.rejects(developmentProviderKey(root, { [providerKeyName]: "key\nINJECTED=yes" }), /invalid/);
});

test("pull retrieves exactly the development binding and writes it privately without returning its value", async (t) => {
  const root = await checkout(t),
    calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return Response.json(
      calls.length === 1
        ? { envs: [{ ...metadata, key: "OPENAI_API_KEY", target: ["production"] }, metadata] }
        : { ...metadata, value: secret },
    );
  };
  const result = await syncDevelopmentSecret(
    "pull",
    root,
    { VERCEL_TOKEN: "inert-vercel-token", OPENAI_API_KEY: "inert-agent" },
    fetcher,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /decrypt=false/u);
  assert.match(calls[1].url, /\/env\/env_development\?/u);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(await developmentProviderKey(root, {}), secret);
  assert.equal((await stat(path.join(root, ".embel-dev/provider.env"))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes(secret));
});

for (const rows of [
  [],
  [{ ...metadata, target: ["production"] }],
  [{ ...metadata, target: ["development", "production"] }],
  [metadata, { ...metadata, id: "env_duplicate" }],
  [{ ...metadata, gitBranch: "feature" }],
  [{ ...metadata, customEnvironmentIds: ["env_custom"] }],
]) {
  test(`ambiguous or nondevelopment key metadata is rejected: ${JSON.stringify(rows.map((row) => ({ target: row.target, gitBranch: row.gitBranch, custom: row.customEnvironmentIds })))}`, async (t) => {
    const root = await checkout(t);
    let calls = 0;
    await writeFile(path.join(root, ".embel-dev/provider.env"), `${providerKeyName}=${secret}\n`);
    await assert.rejects(
      syncDevelopmentSecret("pull", root, { VERCEL_TOKEN: "inert-token" }, async () => {
        calls++;
        return Response.json({ envs: rows });
      }),
      /missing|ambiguous/u,
    );
    assert.equal(calls, 1);
    assert.equal(await developmentProviderKey(root, {}), secret);
  });
}

test("pull refuses a retrieval whose key or targets changed, preserving the previous local value", async (t) => {
  const root = await checkout(t);
  await writeFile(path.join(root, ".embel-dev/provider.env"), `${providerKeyName}=${secret}\n`);
  for (const replacement of [
    { ...metadata, key: "OPENAI_API_KEY" },
    { ...metadata, target: ["development", "production"] },
  ]) {
    let count = 0;
    await assert.rejects(
      syncDevelopmentSecret("pull", root, { VERCEL_TOKEN: "inert-token" }, async () =>
        Response.json(++count === 1 ? { envs: [metadata] } : { ...replacement, value: "inert-foreign-secret" }),
      ),
      /exclusively/u,
    );
    assert.equal(await developmentProviderKey(root, {}), secret);
  }
});

test("push sends only the dedicated key to development and reports no secret", async (t) => {
  const root = await checkout(t),
    calls = [];
  const result = await syncDevelopmentSecret(
    "push",
    root,
    { VERCEL_TOKEN: "inert-token", [providerKeyName]: secret, OPENAI_API_KEY: "inert-agent" },
    async (url, init) => {
      calls.push({ url, init });
      return Response.json(init.method === "POST" ? { created: [metadata] } : { envs: [] });
    },
  );
  const write = calls.find((call) => call.init.method === "POST");
  assert.ok(write);
  assert.deepEqual(JSON.parse(write.init.body).target, ["development"]);
  assert.equal(JSON.parse(write.init.body).key, providerKeyName);
  assert.equal(JSON.parse(write.init.body).value, secret);
  assert.equal(JSON.parse(write.init.body).type, "encrypted");
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("no Vercel credential or no dedicated provider key never causes credential discovery", async (t) => {
  const root = await checkout(t),
    fetcher = () => {
      assert.fail("network call was not authorized by explicit credentials");
    };
  await assert.rejects(syncDevelopmentSecret("pull", root, {}, fetcher), /VERCEL_TOKEN/u);
  await assert.rejects(
    syncDevelopmentSecret("push", root, { VERCEL_TOKEN: "inert-token", OPENAI_API_KEY: "inert-agent" }, fetcher),
    /dedicated/u,
  );
  assert.equal(await readFile(path.join(root, ".embel-dev/provider.env"), "utf8").catch(() => null), null);
});
