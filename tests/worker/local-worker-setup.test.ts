// Next.js augments ProcessEnv with required NODE_ENV; CLI subprocess tests intentionally use clean environments.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localWorkerDatabaseConfiguration, prepareLocalChildEnvironments } from "../../scripts/local-environment.mjs";
import { readHiddenWorkerPassword, validateWorkerSetupInvocation, writeLocalWorkerEnvironment } from "../../scripts/local-worker-setup.mjs";

// All passwords and terminals below are synthetic. No credential or role is
// created outside temporary test directories and no network connection is made.
const roots: string[] = [];
const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "fluid-worker-setup-fixture-")));
  roots.push(root);
  return { root, directory: path.join(root, ".local-fluid"), destination: path.join(root, ".local-fluid/worker.env") };
}
function terminal() {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false, readableFlowing: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, raw: boolean) { this.isRaw = raw; }),
    pause: vi.fn(), resume: vi.fn(),
  });
  const output = { isTTY: true, write: vi.fn() };
  const read = (signal?: AbortSignal) => readHiddenWorkerPassword(input as unknown as ReadStream, output as unknown as WriteStream, "Password: ", { signal });
  return { input, output, read };
}

describe("secure local worker configuration writer", () => {
  it("publishes exactly one protected file and preserves password bytes through the launcher", async () => {
    const { root, directory, destination } = await fixture();
    const password = "synthetic # '$\"\\:@/%?&=`()é🚀 password";
    await writeLocalWorkerEnvironment(root, password);
    const [dir, file] = await Promise.all([lstat(directory), lstat(destination)]);
    expect(dir.mode & 0o7777).toBe(0o700);
    expect(file.mode & 0o7777).toBe(0o600);
    expect(file.uid).toBe(process.getuid?.());
    expect(file.nlink).toBe(1);
    expect(await readdir(directory)).toEqual(["worker.env"]);
    const children = await prepareLocalChildEnvironments(root, {}, { bridgeToken: "synthetic-capability" });
    expect(children.web).not.toHaveProperty("FLUID_WORKER_DATABASE_URL");
    const config = localWorkerDatabaseConfiguration(children.worker.FLUID_WORKER_DATABASE_URL!);
    expect(config).toMatchObject({ host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, database: "postgres",
      user: "fluid_local_worker.fricsfwqibyhemknqgyf", password,
      ssl: { servername: "aws-0-us-east-1.pooler.supabase.com", rejectUnauthorized: true } });
  });
  it("never replaces existing credentials", async () => {
    const { root, destination } = await fixture();
    await writeLocalWorkerEnvironment(root, "synthetic-original");
    const original = await readFile(destination);
    await expect(writeLocalWorkerEnvironment(root, "synthetic-replacement")).rejects.toThrow("Worker configuration");
    expect(await readFile(destination)).toEqual(original);
  });
  it("publishes only one of two concurrent first writes", async () => {
    const { root, directory } = await fixture();
    const results = await Promise.allSettled([
      writeLocalWorkerEnvironment(root, "synthetic-first"), writeLocalWorkerEnvironment(root, "synthetic-second"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await readdir(directory)).toEqual(["worker.env"]);
  });
  it.each(["symlink", "hardlink", "directory"])("refuses an existing %s destination without changing its target", async kind => {
    const { root, directory, destination } = await fixture();
    await mkdir(directory, { mode: 0o700 });
    const target = path.join(root, "keep-private.txt");
    await writeFile(target, "synthetic-original", { mode: 0o600 });
    if (kind === "symlink") await symlink(target, destination);
    else if (kind === "hardlink") await link(target, destination);
    else await mkdir(destination);
    await expect(writeLocalWorkerEnvironment(root, "synthetic-replacement")).rejects.toThrow("Worker configuration");
    expect(await readFile(target, "utf8")).toBe("synthetic-original");
    expect(await readdir(directory)).toEqual(["worker.env"]);
  });
  it("refuses a symlinked protected directory", async () => {
    const { root, directory } = await fixture();
    const target = path.join(root, "other-directory"); await mkdir(target, { mode: 0o700 });
    await symlink(target, directory);
    await expect(writeLocalWorkerEnvironment(root, "synthetic-password")).rejects.toThrow("Worker configuration");
    expect(await readdir(target)).toEqual([]);
  });
  it.each([0o755, 0o770, 0o777])( "refuses permissive directory mode %i without silently changing it", async mode => {
    const { root, directory } = await fixture(); await mkdir(directory); await chmod(directory, mode);
    await expect(writeLocalWorkerEnvironment(root, "synthetic-password")).rejects.toThrow("Worker configuration");
    expect((await lstat(directory)).mode & 0o7777).toBe(mode);
    expect(await readdir(directory)).toEqual([]);
  });
  it("refuses a writable-by-others checkout", async () => {
    const { root } = await fixture(); await chmod(root, 0o777);
    await expect(writeLocalWorkerEnvironment(root, "synthetic-password")).rejects.toThrow("Worker configuration");
    expect(await readdir(root)).toEqual([]);
  });
  it("refuses a symlink alias for the checkout", async () => {
    const { root } = await fixture(); const alias = `${root}-alias`; roots.push(alias); await symlink(root, alias);
    await expect(writeLocalWorkerEnvironment(alias, "synthetic-password")).rejects.toThrow("Worker configuration");
    expect(await readdir(root)).toEqual([]);
  });
  it.each(["", "line\nbreak", "null\0byte", "delete\x7f", "\ud800", "x".repeat(1025)])("rejects invalid passwords without files or reflected input (%#)", async password => {
    const { root } = await fixture();
    const error = await writeLocalWorkerEnvironment(root, password).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^Worker configuration/);
    expect(await readdir(root)).toEqual([]);
  });
  it("cancels before writing", async () => {
    const { root } = await fixture();
    const controller = new AbortController(); controller.abort();
    await expect(writeLocalWorkerEnvironment(root, "synthetic-password", { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(await readdir(root)).toEqual([]);
  });
  it("rejects a different filesystem owner", async () => {
    const { root } = await fixture();
    vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    await expect(writeLocalWorkerEnvironment(root, "synthetic-password")).rejects.toThrow("Worker configuration");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("user-only hidden Terminal entry", () => {
  it("returns password privately, handles Unicode backspace and restores terminal state", async () => {
    const { input, output, read } = terminal(); const result = read();
    input.emit("data", Buffer.from("synthetic-🚀")); input.emit("data", Buffer.from([127])); input.emit("data", Buffer.from("é\r"));
    expect(await result).toBe("synthetic-é");
    expect(output.write.mock.calls).toEqual([["Password: "], ["\n"]]);
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.pause).toHaveBeenCalledOnce();
    expect(input.listenerCount("data")).toBe(0);
  });
  it.each([3, 4])("cancels on terminal control byte %i and restores echo", async code => {
    const { input, output, read } = terminal(); const result = read();
    input.emit("data", Buffer.from("synthetic-secret")); input.emit("data", Buffer.from([code]));
    await expect(result).rejects.toThrow("cancelled");
    expect(input.isRaw).toBe(false);
    expect(JSON.stringify(output.write.mock.calls)).not.toContain("synthetic-secret");
  });
  it("cancels on abort, removes listeners, and restores echo", async () => {
    const { input, read } = terminal(); const controller = new AbortController(); const result = read(controller.signal);
    controller.abort(); await expect(result).rejects.toThrow("cancelled");
    expect(input.isRaw).toBe(false); expect(input.eventNames()).toEqual([]);
  });
  it.each(["input", "output"])("rejects non-TTY %s", async stream => {
    const { input, output, read } = terminal(); (stream === "input" ? input : output).isTTY = false;
    await expect(read()).rejects.toThrow("Worker configuration");
    expect(input.setRawMode).not.toHaveBeenCalled(); expect(output.write).not.toHaveBeenCalled();
  });
  it.each([Buffer.from("synthetic\nsecond-line"), Buffer.from([0xff, 13]), Buffer.alloc(1025, 65)])("rejects unsafe terminal input and does not echo it (%#)", async bytes => {
    const { input, output, read } = terminal(); const result = read(); input.emit("data", bytes);
    await expect(result).rejects.toThrow("Worker configuration");
    expect(input.isRaw).toBe(false); expect(output.write.mock.calls).toEqual([["Password: "], ["\n"]]);
  });
  it.each(["FLUID_WORKER_DATABASE_URL", "DATABASE_URL", "PGPASSWORD", "PGSERVICEFILE", "SUPABASE_DB_PASSWORD"])("refuses inherited %s instead of using it", key => {
    expect(() => validateWorkerSetupInvocation([], { [key]: "synthetic-secret" })).toThrow("Worker configuration");
  });
  it("refuses all command arguments without reflecting them", () => {
    expect(() => validateWorkerSetupInvocation(["synthetic-secret"], {})).toThrow(/^Worker configuration/);
  });
  it("executable refuses piped input without creating files or leaking it", async () => {
    const { root } = await fixture(); await mkdir(path.join(root, "scripts"));
    for (const name of ["local-worker-setup.mjs", "local-environment.mjs"])
      await copyFile(path.join(sourceRoot, "scripts", name), path.join(root, "scripts", name));
    const result = spawnSync(process.execPath, [path.join(root, "scripts/local-worker-setup.mjs")], {
      cwd: tmpdir(), env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, input: "synthetic-secret\n", encoding: "utf8", timeout: 5000,
    });
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("synthetic-secret"); expect(await readdir(root)).toEqual(["scripts"]);
  });
});
