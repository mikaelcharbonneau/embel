import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
const execute = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function run(args: string[]) {
  try {
    const result = await execute(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/logo-worker.mjs", ...args],
      { cwd: root, env: { NODE_ENV: "test" }, encoding: "utf8", timeout: 15_000, maxBuffer: 8192 }); return { code: 0, ...result };
  } catch (error) { const result = error as { code: number; stdout: string; stderr: string }; return { code: result.code, stdout: result.stdout, stderr: result.stderr }; }
}
describe("source-only dedicated executable", () => {
  it.each([[], ["--disabled"]])("stays disabled for %j without a supplied config", async (...args) => {
    const result = await run(args as string[]);
    expect(result).toEqual({ code: 0, stdout: '{"event":"logo_worker_disabled"}\n', stderr: "" });
  });
  it("rejects ambiguous arguments with a fixed message and no path echo", async () => {
    const result = await run(["--disabled", "--config", "/private/synthetic-value/.local-fluid/logo-worker.json"]);
    expect(result.code).toBe(2); expect(result.stdout).toBe("");
    expect(result.stderr).toBe('{"event":"logo_worker_unavailable"}\n');
  });
  it("fails closed for an explicit missing path without discovering another configuration", async () => {
    const result = await run(["--config", "/synthetic-does-not-exist/.local-fluid/logo-worker.json"]);
    expect(result.code).toBe(2); expect(result.stdout + result.stderr).not.toContain("synthetic-does-not-exist");
  });
  it("accepts an explicit protected disabled configuration without constructing a live runtime", async () => {
    const path = await realpath(await mkdtemp(join(tmpdir(), "logo-launcher-executable-synthetic-"))); roots.push(path);
    await mkdir(join(path, ".local-fluid"), { mode: 0o700 }); const filename = join(path, ".local-fluid", "logo-worker.json");
    await writeFile(filename, JSON.stringify({ version: 1, enabled: false }), { mode: 0o600 });
    expect(await run(["--config", filename])).toEqual({ code: 0, stdout: '{"event":"logo_worker_disabled"}\n', stderr: "" });
  });
});
