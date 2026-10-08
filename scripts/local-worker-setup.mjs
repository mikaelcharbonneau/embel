import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localWorkerDatabaseConfiguration } from "./local-environment.mjs";

const HOST = "aws-0-us-east-1.pooler.supabase.com";
const USER = "fluid_local_worker.fricsfwqibyhemknqgyf";
const MAX_PASSWORD_BYTES = 1024;
const SETUP_ERROR = "Worker configuration was not written. Check the protected destination and run setup again in Terminal.";
const CANCELLED = "Worker setup was cancelled.";
const setupError = () => new Error(SETUP_ERROR);
const cancelled = () => new Error(CANCELLED);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owned = info => typeof process.getuid === "function" && info.uid === process.getuid();
const protectedDirectory = info => info.isDirectory() && !info.isSymbolicLink() && owned(info) && (info.mode & 0o7777) === 0o700;
const protectedFile = info => info.isFile() && !info.isSymbolicLink() && owned(info) && (info.mode & 0o7777) === 0o600;

/** Never accepts a URL, role, destination override, or environment credential. */
export function validateWorkerSetupInvocation(args, environment) {
  if (args.length || Object.keys(environment).some(key =>
    key === "FLUID_WORKER_DATABASE_URL" || key === "DATABASE_URL" || key === "SUPABASE_DB_PASSWORD" || /^PG/.test(key))) throw setupError();
}

function credentialContents(password) {
  if (typeof password !== "string" || !password || Buffer.byteLength(password) > MAX_PASSWORD_BYTES ||
      /[\x00-\x1f\x7f]/.test(password) || !password.isWellFormed()) throw setupError();
  // Encoding every dotenv-sensitive character also handles quotes, #, $, spaces,
  // backslashes and non-ASCII passwords without shell or dotenv interpretation.
  const encoded = encodeURIComponent(password).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const url = `postgresql://${USER}:${encoded}@${HOST}:5432/postgres?sslmode=verify-full`;
  const config = localWorkerDatabaseConfiguration(url);
  if (config.host !== HOST || config.user !== USER || config.password !== password || config.ssl?.rejectUnauthorized !== true) throw setupError();
  return Buffer.from(`FLUID_WORKER_DATABASE_URL='${url}'\n`);
}

/** Exported for isolated filesystem tests; the executable fixes root to its checkout. */
export async function writeLocalWorkerEnvironment(root, password, { signal } = {}) {
  let handle, temporary, temporaryInfo, contents;
  const checkCancellation = () => { if (signal?.aborted) throw cancelled(); };
  try {
    checkCancellation();
    contents = credentialContents(password);
    const resolvedRoot = path.resolve(root);
    if (await realpath(resolvedRoot) !== resolvedRoot) throw setupError();
    const rootInfo = await lstat(resolvedRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !owned(rootInfo) || (rootInfo.mode & 0o022)) throw setupError();
    const directory = path.join(resolvedRoot, ".local-fluid");
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw setupError(); }
    const directoryInfo = await lstat(directory);
    const checkDirectories = async () => {
      const [currentRoot, currentDirectory] = await Promise.all([lstat(resolvedRoot), lstat(directory)]);
      if (!sameFile(rootInfo, currentRoot) || !owned(currentRoot) || !currentRoot.isDirectory() || currentRoot.isSymbolicLink() ||
          (currentRoot.mode & 0o022) || !sameFile(directoryInfo, currentDirectory) || !protectedDirectory(currentDirectory)) throw setupError();
    };
    if (!protectedDirectory(directoryInfo)) throw setupError();
    await checkDirectories();
    const destination = path.join(directory, "worker.env");
    // Inspect without following links. Every existing destination is refused,
    // including empty files, symlinks, directories and multiply-linked files.
    try { await lstat(destination); throw setupError(); }
    catch (error) { if (error?.code !== "ENOENT") throw setupError(); }
    checkCancellation();
    temporary = path.join(directory, `.worker-${randomBytes(16).toString("hex")}.tmp`);
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    temporaryInfo = await handle.stat();
    if (!protectedFile(temporaryInfo) || temporaryInfo.nlink !== 1) throw setupError();
    await handle.writeFile(contents);
    await handle.sync();
    const written = await handle.stat();
    if (!sameFile(temporaryInfo, written) || !protectedFile(written) || written.nlink !== 1 || written.size !== contents.length) throw setupError();
    await checkDirectories();
    const beforePublish = await lstat(temporary);
    if (!sameFile(temporaryInfo, beforePublish) || !protectedFile(beforePublish) || beforePublish.nlink !== 1) throw setupError();
    checkCancellation();
    // A hard-link publication is atomic and fails if anything already occupies
    // the destination. rename() would overwrite an existing credential.
    await link(temporary, destination);
    await unlink(temporary);
    temporary = undefined;
    const published = await lstat(destination);
    if (!sameFile(temporaryInfo, published) || !protectedFile(published) || published.nlink !== 1) throw setupError();
    await checkDirectories();
  } catch (error) {
    if (error?.message === CANCELLED) throw cancelled();
    throw setupError();
  } finally {
    contents?.fill(0);
    await handle?.close().catch(() => {});
    if (temporary && temporaryInfo) {
      // Never remove a replacement path supplied by another process.
      try { if (sameFile(temporaryInfo, await lstat(temporary))) await unlink(temporary); } catch { /* protected temporary may need manual cleanup */ }
    }
  }
}

/** Raw terminal input: no echo, masking, history, readline, or secret output. */
export async function readHiddenWorkerPassword(input, output, prompt, { signal } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function" || signal?.aborted) {
    if (signal?.aborted) throw cancelled();
    throw setupError();
  }
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(MAX_PASSWORD_BYTES);
    let size = 0, done = false;
    const wasRaw = input.isRaw === true;
    const wasFlowing = input.readableFlowing === true;
    const finish = (error) => {
      if (done) return;
      done = true;
      input.off("data", onData); input.off("end", onEnd); input.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      try { input.setRawMode(wasRaw); if (!wasFlowing) input.pause(); output.write("\n"); }
      catch { error = setupError(); }
      const value = error ? undefined : bytes.subarray(0, size).toString("utf8");
      if (!error && !Buffer.from(value).equals(bytes.subarray(0, size))) error = setupError();
      bytes.fill(0);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(cancelled());
    const onEnd = () => finish(cancelled());
    const onError = () => finish(setupError());
    const onData = chunk => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let i = 0; i < incoming.length; i++) {
        const byte = incoming[i];
        if (byte === 3 || byte === 4) return finish(cancelled());
        if (byte === 13 || byte === 10) {
          if (incoming.subarray(i).some(value => value !== 10 && value !== 13)) return finish(setupError());
          return finish();
        }
        if (byte === 8 || byte === 127) {
          if (size) { size--; while (size > 0 && (bytes[size] & 0xc0) === 0x80) size--; bytes.fill(0, size); }
        } else if (byte < 32 || size >= bytes.length) return finish(setupError());
        else bytes[size++] = byte;
      }
    };
    input.on("data", onData); input.once("end", onEnd); input.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    try { input.setRawMode(true); output.write(prompt); input.resume(); }
    catch { finish(setupError()); }
  });
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  let password, confirmation, first, second;
  try {
    validateWorkerSetupInvocation(process.argv.slice(2), process.env);
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw setupError();
    const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    process.stdout.write("Fluid local worker setup\nUse the password already assigned to fluid_local_worker.\nNothing is sent to Supabase by this command. Press Ctrl+C to cancel.\n");
    password = await readHiddenWorkerPassword(process.stdin, process.stdout, "Worker password (hidden): ", { signal: controller.signal });
    confirmation = await readHiddenWorkerPassword(process.stdin, process.stdout, "Confirm password (hidden): ", { signal: controller.signal });
    first = Buffer.from(password); second = Buffer.from(confirmation);
    if (!first.length || first.length !== second.length || !timingSafeEqual(first, second)) throw setupError();
    await writeLocalWorkerEnvironment(root, password, { signal: controller.signal });
    process.stdout.write("Saved protected .local-fluid/worker.env. Database authentication has not been tested.\n");
  } catch (error) {
    process.stderr.write(`${error?.message === CANCELLED ? CANCELLED : SETUP_ERROR}\n`);
    process.exitCode = error?.message === CANCELLED ? 130 : 1;
  } finally {
    password = confirmation = undefined;
    first?.fill(0); second?.fill(0);
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
