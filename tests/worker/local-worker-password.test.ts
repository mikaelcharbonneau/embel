// Next.js augments ProcessEnv with required NODE_ENV; CLI subprocess tests intentionally use clean environments.
import { spawnSync, type spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareWorkerPasswordCommand, runWorkerPasswordSetup, validateWorkerPasswordInvocation } from "../../scripts/local-worker-password.mjs";

// Child creation is mocked. No administrator/worker password, database command,
// role mutation or real Postgres connection is used by these tests.
const source = fileURLToPath(new URL("../../scripts/", import.meta.url));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(suffix = "") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `fluid-password-wrapper${suffix}-`))); roots.push(root);
  const cert = path.join(root, "scripts/certs/supabase-prod-ca-2021.crt");
  await mkdir(path.dirname(cert), { recursive: true });
  await copyFile(path.join(source, "certs/supabase-prod-ca-2021.crt"), cert);
  await chmod(cert, 0o644);
  return { root, cert };
}
function terminal() {
  const input = Object.assign(new EventEmitter(), { isTTY: true, read: vi.fn(), on: vi.fn(), resume: vi.fn(), setRawMode: vi.fn() });
  const output = { isTTY: true, write: vi.fn() }, errorOutput = { isTTY: true, write: vi.fn() };
  return { input, output, errorOutput, streams: { input: input as unknown as ReadStream, output: output as unknown as WriteStream, errorOutput: errorOutput as unknown as WriteStream } };
}
function fakeSpawn(code: number | null = 0, signal: NodeJS.Signals | null = null, error = false, errorAfterSpawn = false) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const spawn = vi.fn(() => {
    queueMicrotask(() => {
      if (!error || errorAfterSpawn) child.emit("spawn");
      if (error) child.emit("error", new Error("synthetic-sensitive-error"));
      else child.emit("exit", code, signal);
    });
    return child;
  });
  return { spawn, child, typedSpawn: spawn as unknown as typeof spawnProcess };
}

describe("restricted psql password command", () => {
  it("fixes the executable, sole command, endpoint, TLS, passfile and clean environment", async () => {
    const { root, cert } = await fixture();
    const result = await prepareWorkerPasswordCommand(root);
    expect(result.executable).toBe("/opt/homebrew/opt/libpq/bin/psql");
    expect(result.args.slice(0, 6)).toEqual(["-X", "-W", "-n", "-v", "ON_ERROR_STOP=1", "-d"]);
    expect(result.args.slice(7)).toEqual(["-c", "\\password fluid_local_worker"]);
    const url = new URL(result.args[6]!);
    expect(url.protocol).toBe("postgresql:"); expect(url.hostname).toBe("aws-0-us-east-1.pooler.supabase.com");
    expect(url.port).toBe("5432"); expect(url.username).toBe("postgres.fricsfwqibyhemknqgyf"); expect(url.password).toBe("");
    expect(url.pathname).toBe("/postgres"); expect(url.hash).toBe("");
    expect(Object.fromEntries(url.searchParams)).toEqual({ sslmode: "verify-full", sslrootcert: cert, ssl_min_protocol_version: "TLSv1.2",
      gssencmode: "disable", sslcertmode: "disable", passfile: "/dev/null", connect_timeout: "15" });
    expect(result.options).toEqual({ cwd: root, shell: false, stdio: "inherit",
      env: { PATH: "/usr/bin:/bin", PGPASSFILE: "/dev/null", PSQL_HISTORY: "/dev/null" } });
  });
  it("encodes a certificate path containing spaces and quotes without shell parsing", async () => {
    const { root, cert } = await fixture(" space'quote");
    const result = await prepareWorkerPasswordCommand(root);
    expect(new URL(result.args[6]!).searchParams.get("sslrootcert")).toBe(cert);
    expect(result.options.shell).toBe(false);
  });
  it.each(["changed", "symlink", "hardlink", "writable", "wrong-owner"])("rejects an unsafe certificate: %s", async kind => {
    const { root, cert } = await fixture();
    if (kind === "changed") await writeFile(cert, "synthetic-certificate");
    if (kind === "writable") await chmod(cert, 0o666);
    if (kind === "wrong-owner") vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    if (kind === "hardlink") await link(cert, path.join(root, "copy.crt"));
    if (kind === "symlink") { await copyFile(cert, path.join(root, "copy.crt")); await rm(cert); await symlink(path.join(root, "copy.crt"), cert); }
    await expect(prepareWorkerPasswordCommand(root)).rejects.toThrow("pinned database certificate. No database command was started.");
  });
  it.each(["PGPASSWORD", "PGSERVICEFILE", "PSQLRC", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "SSLKEYLOGFILE", "OPENSSL_CONF", "GITHUB_PERSONAL_ACCESS_TOKEN"])("rejects inherited %s without reflecting it", key => {
    expect(() => validateWorkerPasswordInvocation([], { [key]: "synthetic-sensitive-value" })).toThrow("clean-environment command");
  });
  it("rejects every user option and runtime flag", () => {
    expect(() => validateWorkerPasswordInvocation(["synthetic-secret"], {})).toThrow("No database command was started.");
    expect(() => validateWorkerPasswordInvocation([], {}, ["--inspect"])).toThrow("No database command was started.");
    expect(() => validateWorkerPasswordInvocation([], {})).not.toThrow();
  });
});

describe("terminal handoff without reading secrets", () => {
  it("spawns once with inherited stdio and never reads or configures terminal input", async () => {
    const { root, cert } = await fixture(); const before = await readFile(cert);
    const term = terminal(), child = fakeSpawn();
    expect(await runWorkerPasswordSetup({ root, ...term.streams, environment: { HOME: "synthetic-home", PATH: "synthetic-path" }, spawn: child.typedSpawn })).toBe(0);
    expect(child.spawn).toHaveBeenCalledOnce();
    expect(child.spawn.mock.calls[0]).toEqual(["/opt/homebrew/opt/libpq/bin/psql", expect.any(Array),
      { cwd: root, shell: false, stdio: "inherit", env: { PATH: "/usr/bin:/bin", PGPASSFILE: "/dev/null", PSQL_HISTORY: "/dev/null" } }]);
    expect(term.input.on).not.toHaveBeenCalled(); expect(term.input.read).not.toHaveBeenCalled();
    expect(term.input.resume).not.toHaveBeenCalled(); expect(term.input.setRawMode).not.toHaveBeenCalled();
    expect(await readFile(cert)).toEqual(before);
    expect(term.output.write.mock.calls.flat().join("")).toContain("psql completed the worker password command.");
  });
  it.each([1, 2, 3, 42])("preserves psql exit code %i without retrying or reporting success", async code => {
    const { root } = await fixture(); const term = terminal(), child = fakeSpawn(code);
    expect(await runWorkerPasswordSetup({ root, ...term.streams, environment: {}, spawn: child.typedSpawn })).toBe(code);
    expect(child.spawn).toHaveBeenCalledOnce(); expect(term.output.write.mock.calls.flat().join("")).not.toContain("psql completed");
    expect(term.errorOutput.write.mock.calls.flat().join("")).toContain("verification before any retry");
  });
  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("represents child %s termination with exit %i", async (signal, code) => {
    const { root } = await fixture(); const term = terminal(), child = fakeSpawn(null, signal);
    expect(await runWorkerPasswordSetup({ root, ...term.streams, environment: {}, spawn: child.typedSpawn })).toBe(code);
  });
  it("reports client startup failure without logging the underlying exception", async () => {
    const { root } = await fixture(); const term = terminal(), child = fakeSpawn(null, null, true);
    expect(await runWorkerPasswordSetup({ root, ...term.streams, environment: {}, spawn: child.typedSpawn })).toBe(127);
    expect(child.spawn).toHaveBeenCalledOnce();
    expect(term.errorOutput.write.mock.calls.flat().join("")).not.toContain("synthetic-sensitive");
    expect(term.errorOutput.write.mock.calls.flat().join("")).toContain("could not start");
  });
  it("reports a post-spawn error as uncertain without claiming no command completed", async () => {
    const { root } = await fixture(); const term = terminal(), child = fakeSpawn(null, null, true, true);
    expect(await runWorkerPasswordSetup({ root, ...term.streams, environment: {}, spawn: child.typedSpawn })).toBe(1);
    expect(child.spawn).toHaveBeenCalledOnce();
    const output = term.errorOutput.write.mock.calls.flat().join("");
    expect(output).toContain("verification before any retry");
    expect(output).not.toContain("No password command was completed");
    expect(output).not.toContain("could not start"); expect(output).not.toContain("synthetic-sensitive");
    expect(term.output.write.mock.calls.flat().join("")).not.toContain("psql completed");
    expect(() => child.child.emit("error", new Error("synthetic-sensitive-followup"))).not.toThrow();
  });
  it.each(["input", "output", "errorOutput"] as const)("requires TTY %s before spawning", async stream => {
    const { root } = await fixture(); const term = terminal(), child = fakeSpawn(); term[stream].isTTY = false;
    await expect(runWorkerPasswordSetup({ root, ...term.streams, environment: {}, spawn: child.typedSpawn })).rejects.toThrow("No database command was started.");
    expect(child.spawn).not.toHaveBeenCalled(); expect(term.output.write).not.toHaveBeenCalled();
  });
  it("rejects piped executable input before launching a client", async () => {
    const { root } = await fixture(); const filename = path.join(root, "scripts/local-worker-password.mjs");
    await copyFile(path.join(source, "local-worker-password.mjs"), filename);
    const result = spawnSync(process.execPath, [filename], { cwd: root, env: {} as NodeJS.ProcessEnv, input: "synthetic-not-a-password", encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No database command was started."); expect(result.stderr).not.toContain("synthetic");
  });
});
