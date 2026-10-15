import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { readHiddenWorkerPassword } from "./local-worker-setup.mjs";

const ORIGIN = "https://fricsfwqibyhemknqgyf.supabase.co";
const HOST = "fricsfwqibyhemknqgyf.supabase.co";
const ERROR = "Account setup did not finish. A request may already have succeeded. Check the setup status before trying again.";
const CANCELLED = "Account setup was cancelled. A request may already have succeeded.";
const BEFORE_REQUEST = "Account setup stopped before submission. No account request was sent.";
const CANCELLED_BEFORE_REQUEST = "Account setup was cancelled. No account request was sent.";
const PREFLIGHT = Object.freeze({
  invocation: "Account setup requires the clean-environment command without extra options. No account request was sent.",
  terminal: "Account setup requires an interactive Terminal. No account request was sent.",
  configuration: "Account setup could not read the protected Embel public configuration. No account request was sent.",
});
class AccountSetupPreflightError extends Error {
  constructor(kind) { super(PREFLIGHT[kind]); }
}
const safeMessages = new Set([ERROR, CANCELLED, BEFORE_REQUEST, CANCELLED_BEFORE_REQUEST, ...Object.values(PREFLIGHT)]);
const failure = () => new Error(ERROR);
const cancelled = () => new Error(CANCELLED);
const owned = stat => typeof process.getuid === "function" && stat.uid === process.getuid();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const publicKey = value => typeof value === "string" && /^sb_publishable_[A-Za-z0-9_-]{20,200}$/.test(value);

export function validateAccountSetupInvocation(args, environment, execArgs = []) {
  if (args.length || execArgs.length || Object.keys(environment).some(key =>
    /(?:password|secret|token|key|database_url)$/i.test(key) || /^PG/.test(key) ||
    /^(?:NODE_OPTIONS|NODE_DEBUG|NODE_DEBUG_NATIVE|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|NODE_USE_ENV_PROXY|SSLKEYLOGFILE|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_CONF|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key))) throw new AccountSetupPreflightError("invocation");
}

export async function readAccountPublicConfiguration(root) {
  let handle, bytes;
  try {
    root = path.resolve(root);
    if (await realpath(root) !== root) throw failure();
    const rootBefore = await lstat(root);
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || !owned(rootBefore) || (rootBefore.mode & 0o022)) throw failure();
    const filename = path.join(root, ".env.local");
    const before = await lstat(filename);
    const safe = stat => stat.isFile() && !stat.isSymbolicLink() && owned(stat) && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600 && stat.size <= 65_536;
    if (!safe(before)) throw failure();
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!safe(opened) || !sameFile(before, opened)) throw failure();
    bytes = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65_536) throw failure();
    const contents = bytes.subarray(0, bytesRead).toString("utf8");
    const config = parseEnv(contents);
    const after = await handle.stat(), pathAfter = await lstat(filename), rootAfter = await lstat(root);
    if (!safe(after) || !safe(pathAfter) || !sameFile(before, pathAfter) || !sameFile(before, after) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || !sameFile(rootBefore, rootAfter) || !owned(rootAfter) || (rootAfter.mode & 0o022)) throw failure();
    if (config.NEXT_PUBLIC_SUPABASE_URL !== ORIGIN || !publicKey(config.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)) throw failure();
    return { publishableKey: config.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
  } catch { throw new AccountSetupPreflightError("configuration"); }
  finally { bytes?.fill(0); await handle?.close().catch(() => {}); }
}

export function parseSignupConfirmationLink(value) {
  try {
    if (typeof value !== "string" || value.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(value) || !value.startsWith(`${ORIGIN}/auth/v1/verify?`)) throw failure();
    const url = new URL(value);
    if (url.origin !== ORIGIN || url.pathname !== "/auth/v1/verify" || url.username || url.password || url.port || url.hash) throw failure();
    const entries = [...url.searchParams];
    if (entries.some(([key]) => !["token", "type", "redirect_to"].includes(key)) || new Set(entries.map(([key]) => key)).size !== entries.length) throw failure();
    const tokenHash = url.searchParams.get("token"), type = url.searchParams.get("type");
    if (!tokenHash || !/^[A-Za-z0-9_-]{32,256}$/.test(tokenHash) || !["signup", "email"].includes(type)) throw failure();
    // Current email-template docs use type=email; Auth's documented signup
    // verification accepts confirmation hashes only. Never redeem a recovery or
    // magic-link token and never visit or forward the supplied redirect_to.
    return { token_hash: tokenHash, type: "signup" };
  } catch { throw failure(); }
}

/** One bounded HTTPS POST to a fixed endpoint; no redirects or retries. */
export async function requestAccountSetup(action, key, body, { signal, request = httpsRequest } = {}) {
  if (!["signup", "verify"].includes(action) || !publicKey(key)) throw failure();
  if (signal?.aborted) throw cancelled();
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0, rejectUnauthorized: true, ca: rootCertificates });
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(body));
    if (payload.length > 8192) throw failure();
    return await new Promise((resolve, reject) => {
      let outgoing, incoming, timer, done = false, total = 0;
      const chunks = [];
      const finish = (error, result) => {
        if (done) return;
        done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
        for (const chunk of chunks) chunk.fill(0);
        if (error) { outgoing?.destroy(); incoming?.destroy(); reject(error); }
        else resolve(result);
      };
      const onAbort = () => finish(cancelled());
      try {
        outgoing = request({ protocol: "https:", hostname: HOST, port: 443, path: `/auth/v1/${action}`, method: "POST",
          agent, rejectUnauthorized: true, ca: rootCertificates, minVersion: "TLSv1.2", servername: HOST,
          headers: { apikey: key, "Content-Type": "application/json", "Content-Length": String(payload.length), Accept: "application/json" } }, response => {
          incoming = response;
          if (![200, 201].includes(response.statusCode) || !/^application\/json(?:;|$)/i.test(response.headers["content-type"] ?? "")) return finish(failure());
          response.on("data", chunk => {
            if (done) return;
            const bytes = Buffer.from(chunk); total += bytes.length;
            if (total > 65_536) { bytes.fill(0); return finish(failure()); }
            chunks.push(bytes);
          });
          response.once("error", () => finish(failure()));
          response.once("aborted", () => finish(failure()));
          response.once("end", () => {
            if (done) return;
            let buffer;
            try { buffer = Buffer.concat(chunks); const result = JSON.parse(buffer.toString("utf8")); finish(undefined, result); }
            catch { finish(failure()); }
            finally { buffer?.fill(0); }
          });
        });
        outgoing.once("error", () => finish(failure()));
        timer = setTimeout(() => finish(failure()), 15_000);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) return onAbort();
        outgoing.end(payload);
      } catch { finish(failure()); }
    });
  } catch (error) { throw error?.message === CANCELLED ? cancelled() : failure(); }
  finally { payload?.fill(0); agent.destroy(); }
}

function userIdentity(response, email, confirmed, expectedId) {
  try {
    const user = response?.user ?? response;
    const hasTokens = Boolean(response?.access_token || response?.refresh_token || response?.session);
    if (response && typeof response === "object") {
      delete response.access_token; delete response.refresh_token; delete response.session;
    }
    if (!user || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id) ||
        typeof user.email !== "string" || user.email.toLowerCase() !== email.toLowerCase() || user.is_anonymous !== false ||
        user.role !== "authenticated" || (expectedId && user.id !== expectedId)) throw failure();
    if (confirmed ? (typeof user.email_confirmed_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(user.email_confirmed_at) ||
        !Number.isFinite(Date.parse(user.email_confirmed_at))) : (user.email_confirmed_at || hasTokens)) throw failure();
    return user.id;
  } catch { throw failure(); }
}

/** Separate 4096-byte limit for a hidden confirmation link, not a password. */
export async function readHiddenConfirmationLink(input, output, { signal } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") throw failure();
  if (signal?.aborted) throw cancelled();
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(4096); let size = 0, done = false;
    const wasRaw = input.isRaw === true, wasFlowing = input.readableFlowing === true;
    const finish = error => {
      if (done) return; done = true;
      input.off("data", onData); input.off("end", onEnd); input.off("error", onError); signal?.removeEventListener("abort", onAbort);
      try { input.setRawMode(wasRaw); if (!wasFlowing) input.pause(); output.write("\n"); } catch { error = failure(); }
      const value = bytes.subarray(0, size).toString("utf8");
      if (!Buffer.from(value).equals(bytes.subarray(0, size))) error = failure();
      bytes.fill(0); if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(cancelled()), onEnd = () => finish(cancelled()), onError = () => finish(failure());
    const onData = chunk => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let i = 0; i < incoming.length; i++) {
        const byte = incoming[i];
        if (byte === 3 || byte === 4) return finish(cancelled());
        if (byte === 13 || byte === 10) {
          if (incoming.subarray(i).some(value => value !== 10 && value !== 13)) return finish(failure());
          return finish();
        }
        if (byte === 127 || byte === 8) { if (size) { size--; while (size > 0 && (bytes[size] & 0xc0) === 0x80) size--; bytes.fill(0, size); } }
        else if (byte < 32 || size >= bytes.length) return finish(failure());
        else bytes[size++] = byte;
      }
    };
    input.on("data", onData); input.once("end", onEnd); input.once("error", onError); signal?.addEventListener("abort", onAbort, { once: true });
    try { input.setRawMode(true); output.write("Paste the confirmation link (hidden), then press Enter: "); input.resume(); } catch { finish(failure()); }
  });
}

/** Tests inject a local transport and terminal; the executable supplies neither. */
export async function runLocalAccountSetup({ root, input, output, environment, args = [], execArgs = [], signal, post = requestAccountSetup }) {
  let password, confirmation, email, link, first, second;
  let requestAttempted = false;
  try {
    validateAccountSetupInvocation(args, environment, execArgs);
    if (!input.isTTY || !output.isTTY) throw new AccountSetupPreflightError("terminal");
    const { publishableKey } = await readAccountPublicConfiguration(root);
    output.write("Embel account setup\nThis creates your ordinary account in fluid-platform-dev and sends a confirmation email.\nUse the email of your existing Supabase team account; default mail delivery is limited to team addresses and two emails per hour.\nEmail, password and confirmation link stay hidden. Ctrl+C cancels.\n");
    email = await readHiddenWorkerPassword(input, output, "Email (hidden): ", { signal });
    if (email.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(email)) throw failure();
    password = await readHiddenWorkerPassword(input, output, "New Embel password, at least 8 characters (hidden): ", { signal });
    confirmation = await readHiddenWorkerPassword(input, output, "Confirm password (hidden): ", { signal });
    first = Buffer.from(password); second = Buffer.from(confirmation);
    if ([...password].length < 8 || first.length > 1024 || first.length !== second.length || !timingSafeEqual(first, second)) throw failure();
    if (await readHiddenWorkerPassword(input, output, "Press Enter to create this account and send its confirmation email, or Ctrl+C to cancel: ", { signal }) !== "") throw failure();
    if (signal?.aborted) throw cancelled();
    requestAttempted = true;
    const signup = await post("signup", publishableKey, { email, password }, { signal });
    password = confirmation = undefined; first.fill(0); second.fill(0);
    const ownerId = userIdentity(signup, email, false);
    output.write("Check your email. Copy the Confirm email link without opening it. Do not paste it into chat.\nNo additional email will be requested by this command.\n");
    link = await readHiddenConfirmationLink(input, output, { signal });
    const verification = parseSignupConfirmationLink(link); link = undefined;
    const verified = await post("verify", publishableKey, verification, { signal });
    verification.token_hash = "";
    userIdentity(verified, email, true, ownerId);
    output.write("Email verified. Sign in to Embel using the email and password you entered. No session tokens were saved.\n");
    return { ownerId };
  } catch (error) {
    const wasCancelled = signal?.aborted || error?.message?.includes("cancelled");
    if (requestAttempted) throw wasCancelled ? cancelled() : failure();
    if (error instanceof AccountSetupPreflightError) throw error;
    throw new Error(wasCancelled ? CANCELLED_BEFORE_REQUEST : BEFORE_REQUEST);
  }
  finally { password = confirmation = email = link = undefined; first?.fill(0); second?.fill(0); }
}

async function main() {
  const controller = new AbortController(), stop = () => controller.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    await runLocalAccountSetup({ root: path.resolve(fileURLToPath(new URL("..", import.meta.url))), input: process.stdin, output: process.stdout,
      environment: process.env, args: process.argv.slice(2), execArgs: process.execArgv, signal: controller.signal });
  } catch (error) {
    const message = safeMessages.has(error?.message) ? error.message : ERROR;
    process.stderr.write(`${message}\n`);
    process.exitCode = [CANCELLED, CANCELLED_BEFORE_REQUEST].includes(message) ? 130 : 1;
  }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
