import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { chmod, link, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileVerifiedChatGPTModelStore } from "../../src/server/local-chatgpt/verified-models";

const ownerId = "5d01417c-342d-4d02-8211-c5fec00e3749";
const otherOwnerId = "8d01417c-342d-4d02-8211-c5fec00e3749";
const registrationId = "a".repeat(64);
const verifiedAt = "2026-10-03T00:00:00.000Z";
const now = Date.parse("2026-10-04T02:00:00.000Z");
function record(overrides: Record<string, unknown> = {}) {
  return { ownerId, registrationId, slug: "fixture-omitted", displayName: "Fixture omitted model", verifiedAt,
    evidence: { type: "response.completed", model: "fixture-omitted" }, ...overrides };
}

describe("protected completed-model evidence (temporary synthetic records only)", () => {
  let directory: string;
  let file: string;
  let store: FileVerifiedChatGPTModelStore;
  async function write(models: unknown[] = [record()]) { await writeFile(file, JSON.stringify({ version: 1, models }), { mode: 0o600 }); }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "fluid-verified-model-fixture-"));
    file = join(directory, "verified-models.json");
    store = new FileVerifiedChatGPTModelStore(directory, () => now);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

  it("is inert and never creates directories or records while reading absent evidence", async () => {
    const nested = new FileVerifiedChatGPTModelStore(join(directory, "missing", ".local-fluid"));
    expect(await nested.list(ownerId, registrationId)).toEqual([]);
    expect(await store.list(ownerId, registrationId)).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });
  it("returns only the exact owner and registration's completed model evidence", async () => {
    await write([record(), record({ ownerId: otherOwnerId, slug: "foreign-model", evidence: { type: "response.completed", model: "foreign-model" } }),
      record({ registrationId: "b".repeat(64), slug: "different-registration", evidence: { type: "response.completed", model: "different-registration" } })]);
    expect(await store.list(ownerId, registrationId)).toEqual([{ slug: "fixture-omitted", displayName: "Fixture omitted model" }]);
    expect(await store.list(otherOwnerId, registrationId)).toEqual([{ slug: "foreign-model", displayName: "Fixture omitted model" }]);
    expect(await store.list(otherOwnerId, "b".repeat(64))).toEqual([]);
  });
  it("retains historical evidence beyond 24 hours without promising current access", async () => {
    await write();
    expect(now - Date.parse(verifiedAt)).toBeGreaterThan(86_400_000);
    expect(await store.list(ownerId, registrationId)).toHaveLength(1);
  });
  it.each([
    { evidence: { type: "response.incomplete", model: "fixture-omitted" } },
    { evidence: { type: "response.completed", model: "another-model" } },
    { verifiedAt: "2026-10-04T02:00:00.001Z" },
    { verifiedAt: "yesterday" }, { ownerId: "not-an-owner" }, { registrationId: "../outside" },
    { slug: "../outside" }, { displayName: "control\ncharacter" },
    { accessToken: "synthetic-token-must-not-belong-here" },
  ])("rejects malformed, unproven or future records (%j)", async change => {
    await write([record(change)]);
    await expect(store.list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
  });
  it("rejects duplicate identity/model evidence and too many records", async () => {
    await write([record(), record()]);
    await expect(store.list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
    await write(Array.from({ length: 101 }, (_, index) => record({ slug: `fixture-${index}`, evidence: { type: "response.completed", model: `fixture-${index}` } })));
    await expect(store.list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
  });
  it.each(["{", " ".repeat(65_537), Buffer.from([0xff, 0xfe])])("bounds and rejects invalid file contents", async content => {
    await writeFile(file, content, { mode: 0o600 });
    await expect(store.list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
  });
  it("rejects file and protected directory exposure instead of silently fixing modes", async () => {
    await write(); await chmod(file, 0o644);
    await expect(store.list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
    expect((await lstat(file)).mode & 0o777).toBe(0o644);
    await chmod(file, 0o600); await chmod(directory, 0o755);
    await expect(store.list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
  });
  it("rejects foreign file-system ownership", async () => {
    await write();
    const originalUid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(originalUid + 1);
    await expect(store.list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
  });
  it("rejects file symlinks, hard links and directory replacements", async () => {
    const target = join(directory, "target.json");
    await write(); await link(file, target);
    await expect(store.list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
    await rm(file); await symlink(target, file);
    await expect(store.list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
    await rm(file); await mkdir(file);
    await expect(store.list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
  });
  it("rejects a symlink in any checkout component or an exposed .local-fluid parent", async () => {
    const privatePath = join(directory, ".local-fluid");
    const outside = join(directory, "outside");
    await mkdir(outside, { mode: 0o700 }); await symlink(outside, privatePath);
    await expect(new FileVerifiedChatGPTModelStore(privatePath).list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
    await rm(privatePath); await mkdir(privatePath, { mode: 0o755 });
    const child = join(privatePath, "nested"); await mkdir(child, { mode: 0o700 });
    await expect(new FileVerifiedChatGPTModelStore(child).list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
    const alias = join(directory, "checkout-alias"); await symlink(directory, alias);
    await expect(new FileVerifiedChatGPTModelStore(join(alias, "outside")).list(ownerId, registrationId)).rejects.toThrow("verified_model_store_unavailable");
  });
  it("rejects malformed caller identity before attempting disk access", async () => {
    await expect(store.list("not-an-owner", registrationId)).rejects.toThrow("verified_model_store_unavailable");
    await expect(store.list(ownerId, "../../other-file")).rejects.toThrow("verified_model_store_unavailable");
    expect(await readdir(directory)).toEqual([]);
  });
});
