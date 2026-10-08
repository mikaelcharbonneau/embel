import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoDedicatedPool } from "../../worker/logo-dedicated-pool";
import { logoDedicatedPoolOptions, parseLogoDedicatedConfiguration } from "../../worker/logo-dedicated-config";
import { configurationInput } from "./logo-dedicated-fixture";
const require = createRequire(import.meta.url), execute = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
const certificate = () => readFileSync(new URL("../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8");
describe("explicit JavaScript pg driver", () => {
  it("pins the package-exported JS Client even if an injected pool option selects another driver", async () => {
    const options = logoDedicatedPoolOptions(parseLogoDedicatedConfiguration(configurationInput()), certificate());
    const forbiddenClient = class { constructor() { throw Error("Unapproved driver must never be constructed"); } };
    const pool = createLogoDedicatedPool({ ...options, Client: forbiddenClient as unknown as typeof import("pg").Client });
    try {
      expect(Reflect.get(pool, "Client")).toBe(require("pg/lib/client.js"));
      expect(Reflect.get(pool, "options").ssl).toMatchObject({ ca: certificate(), rejectUnauthorized: true });
    } finally { await pool.end(); }
  });
  it("ignores the ambient native-driver toggle without importing native or making a connection", async () => {
    const script = `try {
      const { createLogoDedicatedPool } = await import('./worker/logo-dedicated-pool.ts');
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const pool = createLogoDedicatedPool({ host: 'synthetic.invalid', port: 5432, database: 'synthetic', user: 'synthetic', password: 'synthetic' });
      if (pool.Client !== require('pg/lib/client.js')) throw new Error('driver');
      await pool.end(); process.stdout.write('javascript-driver-only');
    } catch { process.stderr.write('driver-unavailable'); process.exitCode = 2; }`;
    let result: { code: number; stdout: string; stderr: string };
    try {
      const output = await execute(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", script],
        { cwd: root, env: { NODE_ENV: "test", NODE_PG_FORCE_NATIVE: "1" }, encoding: "utf8", timeout: 15_000, maxBuffer: 8192 });
      result = { code: 0, ...output };
    } catch (error) { const output = error as { code: number; stdout: string; stderr: string }; result = { code: output.code, stdout: output.stdout, stderr: output.stderr }; }
    expect(result).toEqual({ code: 0, stdout: "javascript-driver-only", stderr: "" });
  });
});
