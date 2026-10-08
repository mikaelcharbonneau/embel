import { inspect } from "node:util";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseLogoDedicatedConfiguration, readProtectedLogoDedicatedConfiguration, getLogoDedicatedConfiguration, logoDedicatedPoolOptions } from "../../worker/logo-dedicated-config";
import { configurationInput, syntheticSecret, identity, token, claims, vectorCapability } from "./logo-dedicated-fixture";
const certificate = () => readFileSync(new URL("../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fileFixture(content: string = JSON.stringify(configurationInput())) {
  const root = await mkdtemp(join(tmpdir(), "fluid-dedicated-synthetic-")); roots.push(root);
  const dir = join(root, ".local-fluid"), path = join(dir, "logo-worker.json");
  await mkdir(dir, { mode: 0o700 }); await writeFile(path, content, { mode: 0o600 }); return { root, dir, path };
}
describe("isolated dedicated logo configuration", () => {
  it("is disabled only for absence or the exact explicit disabled shape", () => {
    expect(parseLogoDedicatedConfiguration()).toEqual({ status: "disabled" });
    expect(parseLogoDedicatedConfiguration({ version: 1, enabled: false })).toEqual({ status: "disabled" });
    for (const input of [null, {}, { enabled: false }, { version: 1, enabled: false, database: syntheticSecret }])
      expect(parseLogoDedicatedConfiguration(input).status).toBe("unavailable");
  });
  it("returns an opaque redacted handle and captures immutable configuration", () => {
    const raw = configurationInput(), result = parseLogoDedicatedConfiguration(raw);
    expect(result.status).toBe("configured"); expect(Object.keys(result)).toEqual(["status"]);
    expect(inspect(result, { showHidden: true, depth: 20 })).not.toContain(syntheticSecret);
    expect(JSON.stringify(result)).not.toContain(raw.storage.accessToken);
    raw.binding.ownerId = "d0000000-0000-4000-8000-000000000099";
    const values = getLogoDedicatedConfiguration(result)!;
    expect(values.binding).toEqual(identity); expect(Object.isFrozen(values.binding)).toBe(true);
    expect(getLogoDedicatedConfiguration({ status: "configured" })).toBeNull();
  });
  it.each([
    ["unknown root", (c: ReturnType<typeof configurationInput>) => ({ ...c, url: syntheticSecret })],
    ["unknown host", c => ({ ...c, database: { ...c.database, host: "example.com" } })],
    ["transaction port", c => ({ ...c, database: { ...c.database, port: 6543 } })],
    ["other database", c => ({ ...c, database: { ...c.database, database: "template1" } })],
    ["connection URL", c => ({ ...c, database: { ...c.database, connectionString: syntheticSecret } })],
    ["TLS override", c => ({ ...c, database: { ...c.database, ssl: false } })],
    ["principal override", c => ({ ...c, database: { ...c.database, user: "postgres" } })],
    ["privileged role", c => ({ ...c, binding: { ...c.binding, roleName: "postgres" } })],
    ["zero OID", c => ({ ...c, binding: { ...c.binding, roleOid: 0 } })],
    ["owner Auth subject", c => ({ ...c, storage: { ...c.storage, authUserId: c.binding.ownerId } })],
    ["unapproved session", c => ({ ...c, storage: { ...c.storage, sessionApproved: false } })],
    ["foreign token subject", c => ({ ...c, storage: { ...c.storage, accessToken: token({ ...claims(), sub: identity.ownerId }) } })],
    ["expired token", c => ({ ...c, storage: { ...c.storage, accessToken: token({ ...claims(), exp: 1 }) } })],
    ["different issuer", c => ({ ...c, storage: { ...c.storage, accessToken: token({ ...claims(), iss: "https://example.com/auth/v1" }) } })],
    ["paid gate false", c => ({ ...c, image: { ...c.image, paidCallsApproved: false } })],
    ["different model", c => ({ ...c, image: { ...c.image, model: "another-model" } })],
    ["different rate", c => ({ ...c, image: { ...c.image, rateVersion: "future" } })],
    ["missing image", c => ({ ...c, image: undefined })],
    ["no operations", c => ({ ...c, operations: {} })],
    ["unreviewed directions", c => ({ ...c, operations: { ...c.operations, directions: {} } })],
    ["mismatched lane", c => ({ ...c, operations: { ...c.operations, concepts: c.operations.refinements } })],
    ["incorrect engine", c => ({ ...c, operations: { ...c.operations, vector: { ...c.operations.vector, engine: null } } })],
    ["paid local export", c => ({ ...c, operations: { ...c.operations, exports: { ...c.operations.exports, maxCostMicrousd: 1 } } })],
    ["wrong export policy", c => ({ ...c, operations: { ...c.operations, exports: { ...c.operations.exports, policyIdentity: "a".repeat(64) } } })],
  ] as [string, (c: ReturnType<typeof configurationInput>) => unknown][])("rejects %s with fixed diagnostics", (_name, change) => {
    const result = parseLogoDedicatedConfiguration(change(configurationInput()));
    expect(result).toEqual({ status: "unavailable", code: "invalid_configuration" });
    expect(JSON.stringify(result)).not.toContain(syntheticSecret);
  });
  it("supports only selected zero-cost lanes without requesting an image key", () => {
    const raw = { ...configurationInput(), image: undefined, operations: { vector: vectorCapability() } };
    expect(parseLogoDedicatedConfiguration(raw).status).toBe("configured");
    expect(parseLogoDedicatedConfiguration({ ...raw, image: configurationInput().image }).status).toBe("unavailable");
  });
  it.each(["db.fricsfwqibyhemknqgyf.supabase.co", "aws-0-us-east-1.pooler.supabase.com"])("constructs exact certificate-verified options for %s without URL fallback", host => {
    const input = configurationInput(); input.database.host = host;
    const config = parseLogoDedicatedConfiguration(input), options = logoDedicatedPoolOptions(config, certificate());
    expect(options).toMatchObject({ host, port: 5432, database: "postgres", password: syntheticSecret,
      user: host.startsWith("db.") ? identity.roleName : `${identity.roleName}.fricsfwqibyhemknqgyf`,
      ssl: { rejectUnauthorized: true, ca: certificate() }, max: 3, connectionTimeoutMillis: 10_000, query_timeout: 15_000,
      options: "-c row_security=on", sslnegotiation: "postgres", client_encoding: "UTF8", replication: "false" });
    expect(options).not.toHaveProperty("connectionString");
  });
  it("rejects substituted trust anchors and forged configuration handles without leaking values", () => {
    expect(() => logoDedicatedPoolOptions(parseLogoDedicatedConfiguration(configurationInput()), syntheticSecret)).toThrow("Logo dedicated configuration is unavailable.");
    expect(() => logoDedicatedPoolOptions({ status: "configured" }, certificate())).toThrow("Logo dedicated configuration is unavailable.");
  });
});
describe("explicit protected dedicated config file", () => {
  it("reads only the explicitly named owner-only file", async () => {
    const f = await fileFixture(); expect((await readProtectedLogoDedicatedConfiguration(f.path)).status).toBe("configured");
    expect((await readProtectedLogoDedicatedConfiguration(join(f.root, ".local-fluid", "missing.json"))).status).toBe("unavailable");
    expect((await readProtectedLogoDedicatedConfiguration(".local-fluid/logo-worker.json")).status).toBe("unavailable");
  });
  it.each(["file-mode", "directory-mode", "symlink", "directory-symlink", "hardlink", "wrong-basename", "oversized", "malformed", "bad-utf8"])("rejects %s", async kind => {
    const f = await fileFixture(); let path = f.path;
    if (kind === "file-mode") await chmod(f.path, 0o644);
    if (kind === "directory-mode") await chmod(f.dir, 0o755);
    if (kind === "symlink") { await rm(f.path); await writeFile(join(f.root, "other"), "{}", { mode: 0o600 }); await symlink(join(f.root, "other"), f.path); }
    if (kind === "directory-symlink") { const other = await mkdtemp(join(tmpdir(), "fluid-dedicated-link-")); roots.push(other); await symlink(f.dir, join(other, ".local-fluid")); path = join(other, ".local-fluid", "logo-worker.json"); }
    if (kind === "hardlink") await link(f.path, join(f.root, "other"));
    if (kind === "wrong-basename") { path = join(f.dir, "other.json"); await writeFile(path, JSON.stringify(configurationInput()), { mode: 0o600 }); }
    if (kind === "oversized") await writeFile(f.path, " ".repeat(65_537));
    if (kind === "malformed") await writeFile(f.path, `{${syntheticSecret}`);
    if (kind === "bad-utf8") await writeFile(f.path, Buffer.from([0xff, 0xfe]));
    const result = await readProtectedLogoDedicatedConfiguration(path);
    expect(result).toEqual({ status: "unavailable", code: "unsafe_configuration_file" }); expect(JSON.stringify(result)).not.toContain(f.root);
  });
});
