import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileChatGPTCredentialStore, registrationIdFor } from "../../src/server/local-chatgpt/credentials";
import { LOCAL_OTHER_OWNER, LOCAL_OWNER, localRecord } from "./local-chatgpt-fixtures";

describe("protected Fluid credential files (temporary fixtures only)", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "fluid-credential-fixture-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("is inert on construction/read and creates only owner-protected Fluid files on an explicit write", async () => {
    const root = join(directory, "new", "credentials");
    const store = new FileChatGPTCredentialStore(root);
    expect(await store.list(LOCAL_OWNER)).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
    const firstHost = await store.getHostId();
    expect(await store.getHostId()).toBe(firstHost);
    const record = localRecord({ hostId: firstHost });
    await store.write(record);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "host.json"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, `${record.registrationId}.json`))).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(expect.arrayContaining(["host.json", `${record.registrationId}.json`]));
    expect((await readdir(root)).some(file => file.endsWith(".tmp") || file.endsWith(".lock"))).toBe(false);
  });

  it("atomically rotates all fields and keeps same-email registrations separate by owner/client/subject", async () => {
    const store = new FileChatGPTCredentialStore(directory);
    const first = localRecord();
    const second = localRecord({ clientId: "oaiapp_other_fixture" });
    const foreign = localRecord({ ownerId: LOCAL_OTHER_OWNER });
    await store.write(first); await store.write(second); await store.write(foreign);
    expect(first.registrationId).not.toBe(second.registrationId);
    expect(first.registrationId).not.toBe(foreign.registrationId);
    expect(await store.read(LOCAL_OTHER_OWNER, first.registrationId)).toBeNull();
    expect((await store.list(LOCAL_OWNER)).map(record => record.registrationId).sort()).toEqual([first.registrationId, second.registrationId].sort());
    const rotated = { ...first, tokens: { ...first.tokens!, accessToken: "local-rotated-access", refreshToken: "local-rotated-refresh", scopes: ["openid"], expiresAt: first.tokens!.expiresAt! + 1000 }, updatedAt: first.updatedAt + 1000 };
    await store.withLock(first.registrationId, () => store.write(rotated));
    expect(await store.read(LOCAL_OWNER, first.registrationId)).toEqual(rotated);
    expect(await store.read(LOCAL_OWNER, second.registrationId)).toEqual(second);
    expect(JSON.parse(await readFile(join(directory, `${first.registrationId}.json`), "utf8"))).toEqual(rotated);
  });

  it("denies invalid identity bindings and path traversal", async () => {
    const store = new FileChatGPTCredentialStore(directory);
    const record = localRecord();
    await expect(store.write({ ...record, subject: "wrong-subject" })).rejects.toMatchObject({ code: "credential_store_unavailable" });
    await expect(store.read(LOCAL_OWNER, "../../another-app/credentials")).rejects.toMatchObject({ code: "registration_not_found" });
    expect(registrationIdFor(record)).toBe(record.registrationId);
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects insecure directory/file modes instead of reading exposed credentials", async () => {
    const store = new FileChatGPTCredentialStore(directory);
    const record = localRecord();
    await store.write(record);
    await chmod(join(directory, `${record.registrationId}.json`), 0o644);
    await expect(store.read(LOCAL_OWNER, record.registrationId)).rejects.toMatchObject({ code: "credential_store_unavailable" });
    await expect(store.write(record)).rejects.toMatchObject({ code: "credential_store_unavailable" });
    await chmod(directory, 0o755);
    await expect(store.list(LOCAL_OWNER)).rejects.toMatchObject({ code: "credential_store_unavailable" });
  });

  it("rejects symlink and hardlink credential paths without following or replacing them", async () => {
    const store = new FileChatGPTCredentialStore(directory);
    const record = localRecord();
    await store.write(record);
    const original = join(directory, `${record.registrationId}.json`);
    const other = localRecord({ clientId: "oaiapp_other_fixture" });
    const otherPath = join(directory, `${other.registrationId}.json`);
    await symlink(original, otherPath);
    await expect(store.read(LOCAL_OWNER, other.registrationId)).rejects.toMatchObject({ code: "credential_store_unavailable" });
    await expect(store.write(other)).rejects.toMatchObject({ code: "credential_store_unavailable" });
    expect((await lstat(otherPath)).isSymbolicLink()).toBe(true);
    await link(original, join(directory, "duplicate-fixture.json"));
    await expect(store.read(LOCAL_OWNER, record.registrationId)).rejects.toMatchObject({ code: "credential_store_unavailable" });
  });

  it("rejects a symlink or insecure mode in the private parent before creating credential files", async () => {
    const checkout = join(directory, "checkout"), outside = join(directory, "outside");
    await mkdir(checkout, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
    const privateParent = join(checkout, ".local-fluid");
    await symlink(outside, privateParent);
    const store = new FileChatGPTCredentialStore(join(privateParent, "credentials"));
    await expect(store.getHostId()).rejects.toMatchObject({ code: "credential_store_unavailable" });
    await expect(store.write(localRecord())).rejects.toMatchObject({ code: "credential_store_unavailable" });
    expect(await readdir(outside)).toEqual([]);
    await rm(privateParent);
    await mkdir(privateParent, { mode: 0o755 });
    await expect(store.getHostId()).rejects.toMatchObject({ code: "credential_store_unavailable" });
    expect(await readdir(privateParent)).toEqual([]);
  });

  it("serializes rotating-token ownership across store instances and releases owned locks on failure", async () => {
    const first = new FileChatGPTCredentialStore(directory), second = new FileChatGPTCredentialStore(directory);
    const id = localRecord().registrationId;
    await first.withLock(id, async () => {
      await expect(second.withLock(id, async () => true)).rejects.toMatchObject({ code: "credential_store_busy" });
    });
    await expect(first.withLock(id, async () => { throw new Error("local-fixture-failure"); })).rejects.toThrow("local-fixture-failure");
    expect(await second.withLock(id, async () => "released")).toBe("released");
    expect((await readdir(directory)).some(file => file.endsWith(".lock"))).toBe(false);
  });
});
