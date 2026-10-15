import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PSQL = "/opt/homebrew/opt/libpq/bin/psql";
const CERTIFICATE_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const PREFLIGHT = "Worker password setup could not start. Use the clean-environment command in Terminal without extra options. No database command was started.";
const CERTIFICATE_ERROR = "Worker password setup could not verify its pinned database certificate. No database command was started.";
const START_ERROR = "The PostgreSQL client could not start. No password command was completed.";
const owned = info => typeof process.getuid === "function" && info.uid === process.getuid();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

export function validateWorkerPasswordInvocation(args, environment, execArgs = []) {
  if (args.length || execArgs.length || Object.keys(environment).some(key =>
    /(?:password|secret|token|key|database_url)$/i.test(key) ||
    /^(?:NODE_|DYLD_|LD_|PG|PSQL|SSL_|SSLKEYLOGFILE|OPENSSL_|HTTPS?_PROXY|ALL_PROXY)/i.test(key))) throw new Error(PREFLIGHT);
}

/** Checks public certificate material only; no credential file is read. */
export async function prepareWorkerPasswordCommand(root) {
  let handle, bytes;
  try {
    root = path.resolve(root);
    if (await realpath(root) !== root) throw new Error();
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !owned(rootInfo) || (rootInfo.mode & 0o022)) throw new Error();
    const certificate = path.join(root, "scripts/certs/supabase-prod-ca-2021.crt");
    if (await realpath(certificate) !== certificate) throw new Error();
    const before = await lstat(certificate);
    const safe = info => info.isFile() && !info.isSymbolicLink() && owned(info) && info.nlink === 1 && !(info.mode & 0o022) && info.size <= 8192;
    if (!safe(before)) throw new Error();
    handle = await open(certificate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!safe(opened) || !sameFile(before, opened)) throw new Error();
    bytes = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 8192 || createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex") !== CERTIFICATE_SHA256) throw new Error();
    const after = await handle.stat(), pathAfter = await lstat(certificate), rootAfter = await lstat(root);
    if (!safe(after) || !safe(pathAfter) || !sameFile(before, after) || !sameFile(before, pathAfter) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || !sameFile(rootInfo, rootAfter) || !owned(rootAfter) || (rootAfter.mode & 0o022)) throw new Error();
    const connection = new URL("postgresql://postgres.fricsfwqibyhemknqgyf@aws-0-us-east-1.pooler.supabase.com:5432/postgres");
    for (const [key, value] of Object.entries({ sslmode: "verify-full", sslrootcert: certificate,
      ssl_min_protocol_version: "TLSv1.2", gssencmode: "disable", sslcertmode: "disable", passfile: "/dev/null", connect_timeout: "15" }))
      connection.searchParams.set(key, value);
    return { executable: PSQL, args: ["-X", "-W", "-n", "-v", "ON_ERROR_STOP=1", "-d", connection.toString(), "-c", "\\password fluid_local_worker"],
      options: { cwd: root, stdio: "inherit", shell: false, env: { PATH: "/usr/bin:/bin", PGPASSFILE: "/dev/null", PSQL_HISTORY: "/dev/null" } } };
  } catch { throw new Error(CERTIFICATE_ERROR); }
  finally { bytes?.fill(0); await handle?.close().catch(() => {}); }
}

/** Only psql receives the terminal descriptors. This wrapper never reads stdin. */
export async function runWorkerPasswordSetup({ root, input, output, errorOutput, environment, args = [], execArgs = [], spawn = spawnProcess }) {
  validateWorkerPasswordInvocation(args, environment, execArgs);
  if (!input.isTTY || !output.isTTY || !errorOutput.isTTY) throw new Error(PREFLIGHT);
  const command = await prepareWorkerPasswordCommand(root);
  output.write("Set Embel's restricted worker password\nThe existing owner-bound role must already be prepared.\npsql will ask for the existing project administrator database password, then a NEW worker password twice.\nEnter secrets only at those psql prompts. The administrator password is not saved or reset.\nCtrl+C cancels. This command does not retry.\n");
  const result = await new Promise(resolve => {
    let child, done = false, started = false;
    const finish = result => {
      if (done) return; done = true;
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
      resolve(result);
    };
    const interrupt = () => { child?.kill("SIGINT"); };
    const terminate = () => { child?.kill("SIGTERM"); };
    try {
      child = spawn(command.executable, command.args, command.options);
      child.once("spawn", () => { started = true; });
      // ChildProcess errors can also follow a successful launch, for example
      // when kill() fails. Such an error cannot prove the command did not run.
      child.on("error", () => finish({ code: started ? 1 : 127, started }));
      child.once("exit", (code, signal) => finish({ code: Number.isInteger(code) ? code : 128 + (osConstants.signals[signal] ?? 1), started: true }));
      process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    } catch { finish({ code: started ? 1 : 127, started }); }
  });
  if (!result.started) errorOutput.write(`${START_ERROR}\n`);
  else if (result.code === 0) output.write("psql completed the worker password command. Store that same worker password with the local worker setup command.\n");
  else errorOutput.write("The password command did not finish successfully. Its result may need verification before any retry.\n");
  return result.code;
}

async function main() {
  try {
    process.exitCode = await runWorkerPasswordSetup({ root: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
      input: process.stdin, output: process.stdout, errorOutput: process.stderr, environment: process.env,
      args: process.argv.slice(2), execArgs: process.execArgv });
  } catch (error) {
    process.stderr.write(`${[PREFLIGHT, CERTIFICATE_ERROR].includes(error?.message) ? error.message : START_ERROR}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
