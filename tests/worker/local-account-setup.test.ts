// Next.js augments ProcessEnv with required NODE_ENV; CLI subprocess tests intentionally use clean environments.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { request as httpsRequest, RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSignupConfirmationLink, readAccountPublicConfiguration, readHiddenConfirmationLink, requestAccountSetup, runLocalAccountSetup, validateAccountSetupInvocation } from "../../scripts/local-account-setup.mjs";

// Synthetic fixtures only. Transport is mocked: no signup, confirmation email,
// auth session, or credential is created against a real provider.
const roots: string[] = [];
const ORIGIN = "https://fricsfwqibyhemknqgyf.supabase.co";
const KEY = "sb_publishable_synthetic_public_fixture_key_only";
const HASH = "a".repeat(64);
const EMAIL = "fixture@example.invalid", PASSWORD = "synthetic-password-123";
const OWNER = "11111111-1111-4111-8111-111111111111";
const LINK = `${ORIGIN}/auth/v1/verify?token=${HASH}&type=signup&redirect_to=http%3A%2F%2Flocalhost%3A3000`;
const USER = { id: OWNER, email: EMAIL, role: "authenticated", is_anonymous: false };
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "fluid-account-setup-fixture-"))); roots.push(root);
  const filename = path.join(root, ".env.local");
  await writeFile(filename, `NEXT_PUBLIC_SUPABASE_URL=${ORIGIN}\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${KEY}\n`, { mode: 0o600 });
  return { root, filename };
}
function terminal(answers?: string[]) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false, readableFlowing: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }),
    pause: vi.fn(), resume: vi.fn(),
  });
  const output = { isTTY: true, write: vi.fn((text: string) => {
    if (answers && text.endsWith(": ")) {
      const answer = answers.shift();
      if (answer !== undefined) queueMicrotask(() => input.emit("data", Buffer.from(`${answer}\r`)));
    }
  }) };
  return { input, output, typedInput: input as unknown as ReadStream, typedOutput: output as unknown as WriteStream };
}
function transport(responseValue: unknown = { ok: true }, { status = 200, contentType = "application/json", hang = false, raw }: { status?: number; contentType?: string; hang?: boolean; raw?: Buffer } = {}) {
  const outgoing = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
  const incoming = Object.assign(new EventEmitter(), { statusCode: status, headers: { "content-type": contentType }, destroy: vi.fn() });
  let sent: unknown;
  const request = vi.fn((options: RequestOptions, callback: (response: typeof incoming) => void) => {
    outgoing.end.mockImplementation((body: Buffer) => {
      sent = JSON.parse(body.toString("utf8"));
      if (!hang) queueMicrotask(() => { callback(incoming); incoming.emit("data", raw ?? Buffer.from(JSON.stringify(responseValue))); incoming.emit("end"); });
    });
    return outgoing;
  });
  return { request, outgoing, incoming, sent: () => sent, typedRequest: request as unknown as typeof httpsRequest };
}

describe("account bootstrap configuration and target", () => {
  it("reads only a protected fixed-project public configuration", async () => {
    const { root, filename } = await fixture();
    expect(await readAccountPublicConfiguration(root)).toEqual({ publishableKey: KEY });
    expect((await lstat(filename)).mode & 0o7777).toBe(0o600);
  });
  it.each(["wrong-project", "privileged-key", "symlink", "hardlink", "mode", "owner"])("refuses unsafe configuration: %s", async kind => {
    const { root, filename } = await fixture();
    if (kind === "wrong-project") await writeFile(filename, `NEXT_PUBLIC_SUPABASE_URL=https://other.supabase.co\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${KEY}`);
    if (kind === "privileged-key") await writeFile(filename, `NEXT_PUBLIC_SUPABASE_URL=${ORIGIN}\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_secret_synthetic`);
    if (kind === "mode") await chmod(filename, 0o644);
    if (kind === "owner") vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    if (kind === "hardlink") await link(filename, path.join(root, "copy"));
    if (kind === "symlink") { await copyFile(filename, path.join(root, "copy")); await rm(filename); await symlink(path.join(root, "copy"), filename); }
    await expect(readAccountPublicConfiguration(root)).rejects.toThrow("protected Fluid public configuration. No account request was sent.");
  });
  it.each(["NODE_OPTIONS", "NODE_DEBUG", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "SSLKEYLOGFILE", "HTTPS_PROXY", "https_proxy", "PGPASSWORD", "SUPABASE_ACCESS_TOKEN", "FLUID_WORKER_DATABASE_URL"])("refuses ambient %s", key => {
    expect(() => validateAccountSetupInvocation([], { [key]: "synthetic-secret" })).toThrow(/^Account setup/);
  });
  it("refuses runtime hooks and all CLI arguments", () => {
    expect(() => validateAccountSetupInvocation([PASSWORD], {})).toThrow(/^Account setup/);
    expect(() => validateAccountSetupInvocation([], {}, ["--inspect"])).toThrow(/^Account setup/);
  });
  it("accepts a clean environment without relaxing its guards", () => {
    expect(() => validateAccountSetupInvocation([], {}, [])).not.toThrow();
  });
  it.each(["signup", "email"])("accepts the documented %s link label but always requests signup-only verification", type => {
    expect(parseSignupConfirmationLink(LINK.replace("type=signup", `type=${type}`))).toEqual({ token_hash: HASH, type: "signup" });
  });
  it.each([
    LINK.replace("https:", "http:"), LINK.replace("fricsfwqibyhemknqgyf", "attacker"), LINK.replace("/auth/v1/verify", "/other"),
    LINK.replace("type=signup", "type=recovery"), LINK.replace("type=signup", "type=magiclink"), LINK.replace("type=signup", "type=invite"),
    `${LINK}&type=signup`, `${LINK}&%74oken=${HASH}`, `${LINK}#access_token=synthetic`, `${LINK}&token_hash=${HASH}`,
    LINK.replace(HASH, "short"), LINK.replace("https://", "https://user:password@"), `${LINK}&unknown=value`, `${LINK}\n`,
  ])("rejects foreign, ambiguous, or unrelated confirmation links (%#)", value => {
    expect(() => parseSignupConfirmationLink(value)).toThrow(/^Account setup/);
  });
});

describe("bounded direct auth transport", () => {
  it("posts to only the fixed HTTPS endpoint with explicit TLS and a dedicated agent", async () => {
    const mock = transport();
    expect(await requestAccountSetup("verify", KEY, { token_hash: HASH, type: "signup" }, { request: mock.typedRequest })).toEqual({ ok: true });
    expect(mock.request).toHaveBeenCalledOnce();
    const options = mock.request.mock.calls[0]![0];
    expect(options).toMatchObject({ protocol: "https:", hostname: "fricsfwqibyhemknqgyf.supabase.co", path: "/auth/v1/verify",
      port: 443, method: "POST", rejectUnauthorized: true, minVersion: "TLSv1.2", headers: { apikey: KEY } });
    expect(options.ca).toBeInstanceOf(Array); expect(options.agent).toBeTruthy();
    expect(mock.sent()).toEqual({ token_hash: HASH, type: "signup" });
  });
  it.each([302, 400, 429, 500])("rejects status %i without following redirects or retrying", async status => {
    const mock = transport({ access_token: "synthetic-token" }, { status });
    await expect(requestAccountSetup("signup", KEY, { email: EMAIL, password: PASSWORD }, { request: mock.typedRequest })).rejects.toThrow(/^Account setup/);
    expect(mock.request).toHaveBeenCalledOnce(); expect(mock.outgoing.destroy).toHaveBeenCalledOnce();
  });
  it.each(["html", "invalid-json", "oversize"])("rejects %s without reflecting response contents", async kind => {
    const mock = transport({}, kind === "html" ? { contentType: "text/html" } : { raw: Buffer.from(kind === "oversize" ? "x".repeat(65_537) : "synthetic-sensitive-response") });
    const result = await requestAccountSetup("verify", KEY, {}, { request: mock.typedRequest }).catch(error => error);
    expect(result).toBeInstanceOf(Error); expect(result instanceof Error ? result.message : "unexpected-success").not.toContain("sensitive"); expect(mock.request).toHaveBeenCalledOnce();
  });
  it("times out once without retrying", async () => {
    vi.useFakeTimers(); const mock = transport({}, { hang: true });
    const pending = requestAccountSetup("signup", KEY, {}, { request: mock.typedRequest });
    const checked = expect(pending).rejects.toThrow(/^Account setup/);
    await vi.advanceTimersByTimeAsync(15_000); await checked;
    expect(mock.request).toHaveBeenCalledOnce(); expect(mock.outgoing.destroy).toHaveBeenCalledOnce();
  });
  it("cancels before issuing a request", async () => {
    const mock = transport(); const controller = new AbortController(); controller.abort();
    await expect(requestAccountSetup("signup", KEY, {}, { signal: controller.signal, request: mock.typedRequest })).rejects.toThrow("cancelled");
    expect(mock.request).not.toHaveBeenCalled();
  });
});

describe("user-completed account bootstrap", () => {
  async function scenario(overrides: { signup?: unknown; verified?: unknown; answers?: string[] } = {}) {
    const { root } = await fixture();
    const term = terminal(overrides.answers ?? [EMAIL, PASSWORD, PASSWORD, "", LINK]);
    const signup = overrides.signup ?? { ...USER };
    const verified = overrides.verified ?? { user: { ...USER, email_confirmed_at: "2026-10-04T00:00:00Z" }, access_token: "synthetic-access", refresh_token: "synthetic-refresh" };
    const post = vi.fn(async (action: string) => action === "signup" ? signup : verified);
    const result = runLocalAccountSetup({ root, input: term.typedInput, output: term.typedOutput, environment: {}, post });
    return { root, term, post, result, verified };
  }
  it("waits for explicit Enter, verifies matching identity, and saves no credentials or sessions", async () => {
    const test = await scenario();
    expect(await test.result).toEqual({ ownerId: OWNER });
    expect(test.post).toHaveBeenCalledTimes(2);
    expect(test.post.mock.calls.map(call => call[0])).toEqual(["signup", "verify"]);
    expect(test.verified).not.toHaveProperty("access_token"); expect(test.verified).not.toHaveProperty("refresh_token");
    expect(await readdir(test.root)).toEqual([".env.local"]);
    const output = test.term.output.write.mock.calls.flat().join("");
    for (const sensitive of [EMAIL, PASSWORD, LINK, HASH, "synthetic-access", "synthetic-refresh", KEY]) expect(output).not.toContain(sensitive);
    expect(output).toContain("Email verified."); expect(test.term.input.isRaw).toBe(false);
  });
  it("does not submit until the user has pressed the explicit final Enter", async () => {
    const test = await scenario({ answers: [EMAIL, PASSWORD, PASSWORD, "not-enter"] });
    await expect(test.result).rejects.toThrow(/^Account setup/); expect(test.post).not.toHaveBeenCalled();
  });
  it("does not submit mismatched passwords", async () => {
    const test = await scenario({ answers: [EMAIL, PASSWORD, "different-password"] });
    await expect(test.result).rejects.toThrow("before submission. No account request was sent."); expect(test.post).not.toHaveBeenCalled();
  });
  it("classifies an unrelated inherited token before prompts or any account request", async () => {
    const { root } = await fixture(); const term = terminal(); const post = vi.fn();
    const result = await runLocalAccountSetup({ root, input: term.typedInput, output: term.typedOutput,
      environment: { GITHUB_PERSONAL_ACCESS_TOKEN: "synthetic-unrelated-token" }, post }).catch(error => error);
    expect(result.message).toBe("Account setup requires the clean-environment command without extra options. No account request was sent.");
    expect(result.message).not.toContain("GITHUB"); expect(result.message).not.toContain("synthetic");
    expect(post).not.toHaveBeenCalled(); expect(term.output.write).not.toHaveBeenCalled();
  });
  it("classifies noninteractive input before prompts or any account request", async () => {
    const { root } = await fixture(); const term = terminal(); term.input.isTTY = false; const post = vi.fn();
    await expect(runLocalAccountSetup({ root, input: term.typedInput, output: term.typedOutput, environment: {}, post }))
      .rejects.toThrow("interactive Terminal. No account request was sent.");
    expect(post).not.toHaveBeenCalled(); expect(term.output.write).not.toHaveBeenCalled();
  });
  it("preserves configuration failure classification before prompts or any account request", async () => {
    const { root, filename } = await fixture(); await chmod(filename, 0o644); const term = terminal(); const post = vi.fn();
    await expect(runLocalAccountSetup({ root, input: term.typedInput, output: term.typedOutput, environment: {}, post }))
      .rejects.toThrow("protected Fluid public configuration. No account request was sent.");
    expect(post).not.toHaveBeenCalled(); expect(term.output.write).not.toHaveBeenCalled();
  });
  it("reports cancellation before submission without ambiguous request wording", async () => {
    const test = await scenario({ answers: [EMAIL, PASSWORD, PASSWORD, "\x03"] });
    await expect(test.result).rejects.toThrow("Account setup was cancelled. No account request was sent.");
    expect(test.post).not.toHaveBeenCalled();
  });
  it("keeps an invoked request failure ambiguous and does not retry or reflect its error", async () => {
    const { root } = await fixture(); const term = terminal([EMAIL, PASSWORD, PASSWORD, ""]);
    const post = vi.fn(async () => { throw new Error("synthetic-sensitive-response"); });
    const result = await runLocalAccountSetup({ root, input: term.typedInput, output: term.typedOutput, environment: {}, post }).catch(error => error);
    expect(result.message).toBe("Account setup did not finish. A request may already have succeeded. Check the setup status before trying again.");
    expect(post).toHaveBeenCalledOnce();
  });
  it("keeps cancellation after signup ambiguous without requesting verification", async () => {
    const test = await scenario({ answers: [EMAIL, PASSWORD, PASSWORD, "", "\x03"] });
    await expect(test.result).rejects.toThrow("Account setup was cancelled. A request may already have succeeded.");
    expect(test.post).toHaveBeenCalledOnce();
  });
  it.each([
    { ...USER, is_anonymous: true }, { ...USER, role: "service_role" }, { ...USER, email: "other@example.invalid" },
    { ...USER, email_confirmed_at: "2026-10-04T00:00:00Z" }, { ...USER, access_token: "synthetic" },
  ])("refuses an unsuitable signup response before confirmation (%#)", async signup => {
    const test = await scenario({ signup }); await expect(test.result).rejects.toThrow(/^Account setup/);
    expect(test.post).toHaveBeenCalledOnce();
  });
  it.each([
    { ...USER }, { ...USER, email_confirmed_at: "bad" }, { ...USER, email_confirmed_at: 1 }, { ...USER, email_confirmed_at: "1" },
    { ...USER, email_confirmed_at: "2026-10-04T00:00:00Z", is_anonymous: true },
    { ...USER, email_confirmed_at: "2026-10-04T00:00:00Z", email: "other@example.invalid" },
    { ...USER, email_confirmed_at: "2026-10-04T00:00:00Z", id: "22222222-2222-4222-8222-222222222222" },
  ])("reports no success for an unconfirmed, anonymous or mismatched result (%#)", async user => {
    const test = await scenario({ verified: { user, access_token: "synthetic" } });
    await expect(test.result).rejects.toThrow(/^Account setup/);
    expect(test.term.output.write.mock.calls.flat().join("")).not.toContain("Email verified.");
  });
  it("does not issue verification for an invalid pasted link", async () => {
    const test = await scenario({ answers: [EMAIL, PASSWORD, PASSWORD, "", LINK.replace("type=signup", "type=recovery")] });
    await expect(test.result).rejects.toThrow(/^Account setup/); expect(test.post).toHaveBeenCalledOnce();
  });
  it("reads a link longer than the password limit without echoing it", async () => {
    const term = terminal(); const link = `${LINK}${"a".repeat(1500)}`;
    const pending = readHiddenConfirmationLink(term.typedInput, term.typedOutput);
    term.input.emit("data", Buffer.from(`${link}\r`)); expect(await pending).toBe(link);
    expect(term.output.write.mock.calls.flat().join("")).not.toContain(HASH); expect(term.input.isRaw).toBe(false);
  });
  it("cancels hidden link entry and restores terminal state", async () => {
    const term = terminal(); const pending = readHiddenConfirmationLink(term.typedInput, term.typedOutput);
    term.input.emit("data", Buffer.from([3])); await expect(pending).rejects.toThrow("cancelled");
    expect(term.input.isRaw).toBe(false); expect(term.input.eventNames()).toEqual([]);
  });
  it("executable rejects piped input before network or credential reads", async () => {
    const { root } = await fixture(); await mkdir(path.join(root, "scripts"));
    const source = fileURLToPath(new URL("../../scripts/", import.meta.url));
    for (const name of ["local-account-setup.mjs", "local-worker-setup.mjs", "local-environment.mjs"])
      await copyFile(path.join(source, name), path.join(root, "scripts", name));
    const result = spawnSync(process.execPath, [path.join(root, "scripts/local-account-setup.mjs")], { cwd: tmpdir(), env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, input: PASSWORD, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain(PASSWORD);
    expect(result.stderr).toBe("Account setup requires an interactive Terminal. No account request was sent.\n");
    expect(await readdir(root)).toEqual([".env.local", "scripts"]);
  });
  it("executable preserves its static environment classification without exposing a token name or value", async () => {
    const { root } = await fixture(); await mkdir(path.join(root, "scripts"));
    const source = fileURLToPath(new URL("../../scripts/", import.meta.url));
    for (const name of ["local-account-setup.mjs", "local-worker-setup.mjs", "local-environment.mjs"])
      await copyFile(path.join(source, name), path.join(root, "scripts", name));
    const result = spawnSync(process.execPath, [path.join(root, "scripts/local-account-setup.mjs")], { cwd: tmpdir(),
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "synthetic-unrelated-token" } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Account setup requires the clean-environment command without extra options. No account request was sent.\n");
  });
});
