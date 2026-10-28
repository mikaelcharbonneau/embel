import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { AccountHttpConfiguration } from "@/server/runtime/account-http-configuration";
import type { AccountHttpRuntime } from "@/server/runtime/account-http-services";
vi.mock("server-only", () => ({}));
import { acquireAccountIdentityRuntime, createAccountHttpBindingSourceRuntime, startAccountHttpBindingSource } from "@/server/runtime/account-http-binding-source";
import { LOGO_SUPABASE_ORIGIN } from "@/server/runtime/logo-web-configuration";
import { createHomeAttachmentService, stageHomeAttachment } from "@/server/home-attachments";

const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ownerC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const key = "sb_publishable_synthetic_http_source";
function fixtureRecord(ownerId: string, oid: number, generation = 1, revision = 1) {
  const identity = { managementVersion: 2 as const, generation, revision, capability: "identity_transactions" as const,
    operationKey: randomUUID(), roleName: `embel_identity_web_${ownerId.replaceAll("-", "")}`, roleOid: oid,
    managerRoleName: "embel_account_role_manager" as const, managerRoleOid: 99 };
  const attachments = { ...identity, capability: "home_attachments" as const, roleName: `embel_home_web_${ownerId.replaceAll("-", "")}`, roleOid: oid + 1, operationKey: randomUUID() };
  const configuration = (binding: typeof identity | typeof attachments) => ({ ...binding,
    databaseUrl: `postgresql://${binding.roleName}:synthetic-password@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full` });
  return { ownerId, generation, revision, identity: { publicationReceipt: `synthetic:${identity.operationKey}`, configuration: configuration(identity) },
    attachments: { publicationReceipt: `synthetic:${attachments.operationKey}`, configuration: configuration(attachments) } };
}
type RecordValue = ReturnType<typeof fixtureRecord>;
function snapshot(record: RecordValue) { return { ownerId: record.ownerId, generation: record.generation, revision: record.revision,
  identity: { operationKey: record.identity.configuration.operationKey, publicationReceipt: record.identity.publicationReceipt, ready: true },
  attachments: { operationKey: record.attachments.configuration.operationKey, publicationReceipt: record.attachments.publicationReceipt, ready: true } }; }
function harness(capacity = 100) {
  const records = new Map<string, RecordValue>([fixtureRecord(ownerA, 101), fixtureRecord(ownerB, 201), fixtureRecord(ownerC, 301)].map(value => [value.ownerId, value]));
  const authorities = new Map([...records].map(([owner, record]) => [owner, snapshot(record)]));
  const prepared: { configuration: AccountHttpConfiguration; runtime: AccountHttpRuntime }[] = [];
  const source = { read: vi.fn(async (ownerId: string, _signal?: AbortSignal): Promise<unknown> => { void _signal; return records.get(ownerId) ?? null; }) };
  const createRuntime = vi.fn((configuration: AccountHttpConfiguration): AccountHttpRuntime => {
    const runtime = { resolveIdentity: vi.fn(async () => ({ transactions: {} as never, saveAvailability: { status: "available" as const } })),
      resolveHome: vi.fn(async () => createHomeAttachmentService(null)), close: vi.fn(async () => {}) };
    prepared.push({ configuration, runtime }); return runtime;
  });
  const runtime = createAccountHttpBindingSourceRuntime({ source, createRuntime, publishableKey: key, capacity });
  function auth(ownerId = ownerA): AuthenticatedContext {
    return { userId: ownerId, client: { rpc: vi.fn(async () => ({ data: authorities.get(ownerId) ?? null, error: null })),
      auth: { getSession: vi.fn(), getUser: vi.fn() } } } as unknown as AuthenticatedContext;
  }
  return { records, authorities, source, prepared, createRuntime, runtime, auth };
}
function resetSlots() { for (const key of ["embel.account-http.binding-source.v1", "embel.account-http.runtime.v1"]) Reflect.deleteProperty(globalThis, Symbol.for(key)); }
afterEach(() => { resetSlots(); vi.unstubAllEnvs(); });

describe("verified owner dynamic HTTP binding source and leased pool cache", () => {
  it("authorizes before source lookup, rechecks current SQL state, and selects independent owner pools without caching request readiness", async () => {
    const h = harness(), accountA = h.auth(), accountB = h.auth(ownerB);
    for (const account of [accountA, accountB, accountA]) {
      const lease = await h.runtime.acquireIdentity(account); expect(lease.configured).toBe(true); expect(lease.value).not.toBeNull(); await lease.release();
    }
    expect(h.createRuntime).toHaveBeenCalledTimes(2); expect(h.source.read).toHaveBeenCalledTimes(3);
    expect(accountA.client.rpc).toHaveBeenCalledTimes(4); expect(accountA.client.rpc).toHaveBeenCalledWith("get_account_service_enrollment_binding");
    expect(h.prepared[0]!.runtime.resolveIdentity).toHaveBeenCalledTimes(2); expect(h.prepared[1]!.runtime.resolveIdentity).toHaveBeenCalledWith(ownerB, expect.any(AbortSignal));
    expect(h.prepared[0]!.configuration.owners[0]!.identity!.managed).toMatchObject({ managementVersion: 2, capability: "identity_transactions", managerRoleName: "embel_account_role_manager" });
    expect(JSON.stringify(h.prepared[0]!.configuration)).not.toContain("synthetic-password");
    expect(accountA.client.auth.getSession).not.toHaveBeenCalled(); await h.runtime.close();
  });
  it.each(["unknown", "foreign-authority", "pending", "unavailable-rpc"])("rejects %s before any source/credential lookup", async mode => {
    const h = harness(), account = h.auth();
    if (mode === "unknown") h.authorities.delete(ownerA);
    if (mode === "foreign-authority") h.authorities.set(ownerA, snapshot(h.records.get(ownerB)!));
    if (mode === "pending") h.authorities.get(ownerA)!.identity.ready = false;
    if (mode === "unavailable-rpc") vi.mocked(account.client.rpc).mockResolvedValue({ data: null, error: { message: "private database detail" } } as never);
    expect((await h.runtime.acquireIdentity(account)).value).toBeNull(); expect(h.source.read).not.toHaveBeenCalled(); expect(h.createRuntime).not.toHaveBeenCalled(); await h.runtime.close();
  });
  it.each(["foreign-owner", "generation", "revision", "operation", "receipt", "manager", "role", "target", "unknown-field"])("rejects untrusted source %s before pool creation, SQL qualification or token selection", async mode => {
    const h = harness(), account = h.auth(), record = h.records.get(ownerA)!;
    if (mode === "foreign-owner") record.ownerId = ownerB;
    if (mode === "generation") record.generation++;
    if (mode === "revision") record.revision++;
    if (mode === "operation") record.identity.configuration.operationKey = randomUUID();
    if (mode === "receipt") record.identity.publicationReceipt = "foreign-receipt";
    if (mode === "manager") Object.assign(record.identity.configuration, { managerRoleName: "postgres" });
    if (mode === "role") record.identity.configuration.roleName = h.records.get(ownerB)!.identity.configuration.roleName;
    if (mode === "target") record.identity.configuration.databaseUrl = record.identity.configuration.databaseUrl.replace("db.fricsfwqibyhemknqgyf.supabase.co", "other.invalid");
    if (mode === "unknown-field") Object.assign(record, { owner: ownerB });
    expect((await h.runtime.acquireIdentity(account)).value).toBeNull(); expect(h.createRuntime).not.toHaveBeenCalled(); expect(account.client.auth.getSession).not.toHaveBeenCalled(); await h.runtime.close();
  });
  it("rejects a ban/generation change during source lookup before constructing any pool", async () => {
    const h = harness(), account = h.auth();
    h.source.read.mockImplementation(async () => { h.authorities.get(ownerA)!.revision++; return h.records.get(ownerA)!; });
    expect((await h.runtime.acquireHome(account)).value).toBeNull(); expect(h.createRuntime).not.toHaveBeenCalled(); expect(account.client.auth.getSession).not.toHaveBeenCalled(); await h.runtime.close();
  });
  it("bounds active entries, evicts only idle LRU entries and does not close an in-use request", async () => {
    const h = harness(2), a = await h.runtime.acquireIdentity(h.auth()), b = await h.runtime.acquireIdentity(h.auth(ownerB));
    expect((await h.runtime.acquireIdentity(h.auth(ownerC))).value).toBeNull(); expect(h.createRuntime).toHaveBeenCalledTimes(2);
    expect(h.prepared[0]!.runtime.close).not.toHaveBeenCalled(); expect(h.prepared[1]!.runtime.close).not.toHaveBeenCalled();
    await a.release(); await a.release();
    const c = await h.runtime.acquireIdentity(h.auth(ownerC)); expect(c.value).not.toBeNull(); expect(h.prepared[0]!.runtime.close).toHaveBeenCalledTimes(1);
    let closed = false; const closing = h.runtime.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); expect(h.prepared[1]!.runtime.close).not.toHaveBeenCalled();
    await b.release(); await c.release(); await closing; expect(closed).toBe(true);
    for (const entry of h.prepared) expect(entry.runtime.close).toHaveBeenCalledTimes(1);
  });
  it("bounds cached pools rather than total enrolled customers", async () => {
    const h = harness(2);
    for (let i = 0; i < 105; i++) {
      const owner = randomUUID(), record = fixtureRecord(owner, 1000 + i * 2); h.records.set(owner, record); h.authorities.set(owner, snapshot(record));
      const lease = await h.runtime.acquireIdentity(h.auth(owner)); expect(lease.value).not.toBeNull(); await lease.release();
    }
    expect(h.createRuntime).toHaveBeenCalledTimes(105); expect(h.prepared.filter(entry => vi.mocked(entry.runtime.close).mock.calls.length === 0)).toHaveLength(2); await h.runtime.close();
  });
  it("retires old generations only after their final lease release", async () => {
    const h = harness(2), first = await h.runtime.acquireIdentity(h.auth());
    const replacement = fixtureRecord(ownerA, 101, 2, 3); h.records.set(ownerA, replacement); h.authorities.set(ownerA, snapshot(replacement));
    const second = await h.runtime.acquireIdentity(h.auth()); expect(second.value).not.toBeNull(); expect(h.createRuntime).toHaveBeenCalledTimes(2);
    expect(h.prepared[0]!.runtime.close).not.toHaveBeenCalled(); await first.release(); expect(h.prepared[0]!.runtime.close).toHaveBeenCalledTimes(1);
    await second.release(); await h.runtime.close();
  });
  it("rejects a role OID collision across owners before creating the second pool", async () => {
    const h = harness(), first = await h.runtime.acquireIdentity(h.auth());
    h.records.get(ownerB)!.identity.configuration.roleOid = 101;
    expect((await h.runtime.acquireIdentity(h.auth(ownerB))).value).toBeNull(); expect(h.createRuntime).toHaveBeenCalledTimes(1);
    await first.release(); await h.runtime.close();
  });
  it("does no late pool work after aborting an external lookup", async () => {
    const h = harness(), stop = new AbortController(); let complete!: (value: unknown) => void;
    h.source.read.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const operation = h.runtime.acquireIdentity(h.auth(), stop.signal);
    await vi.waitFor(() => expect(h.source.read).toHaveBeenCalled()); stop.abort(); expect((await operation).value).toBeNull();
    complete(h.records.get(ownerA)); await Promise.resolve(); await Promise.resolve(); expect(h.createRuntime).not.toHaveBeenCalled(); await h.runtime.close();
  });
  it("releases a failed qualification so an idle entry can be evicted", async () => {
    const h = harness(1), first = await h.runtime.acquireIdentity(h.auth()); await first.release();
    vi.mocked(h.prepared[0]!.runtime.resolveIdentity).mockResolvedValue(null);
    expect((await h.runtime.acquireIdentity(h.auth())).value).toBeNull();
    const next = await h.runtime.acquireIdentity(h.auth(ownerB)); expect(next.value).not.toBeNull(); await next.release(); await h.runtime.close();
  });
  it.each(["auth", "pending", "withdrawn"])("retires idle owner pools after %s authority is rejected", async mode => {
    const h = harness(), first = await h.runtime.acquireIdentity(h.auth()); await first.release();
    if (mode === "auth") h.authorities.delete(ownerA);
    if (mode === "pending") h.authorities.get(ownerA)!.identity.ready = false;
    if (mode === "withdrawn") h.source.read.mockResolvedValue(null);
    expect((await h.runtime.acquireIdentity(h.auth())).value).toBeNull();
    expect(h.prepared[0]!.runtime.close).toHaveBeenCalledTimes(1); await h.runtime.close();
  });
  it("withdraws a held owner pool only after its existing request releases", async () => {
    const h = harness(), first = await h.runtime.acquireIdentity(h.auth()); h.authorities.delete(ownerA);
    expect((await h.runtime.acquireIdentity(h.auth())).value).toBeNull(); expect(h.prepared[0]!.runtime.close).not.toHaveBeenCalled();
    await first.release(); expect(h.prepared[0]!.runtime.close).toHaveBeenCalledTimes(1); await h.runtime.close();
  });
});

describe("explicit optional source startup and call-site release", () => {
  const environment = { EMBEL_ACCOUNT_HTTP_SOURCE_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: LOGO_SUPABASE_ORIGIN,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key, EMBEL_ACCOUNT_HTTP_SOURCE_CONFIG: JSON.stringify({ vault: {}, publicationPrefix: "http", credentialPrefix: "credentials" }) };
  it("suppresses static/development fallback whenever the explicit source is configured but unavailable", async () => {
    const legacy = { resolveIdentity: vi.fn(async () => ({ saveAvailability: { status: "available" } })) };
    Object.defineProperty(globalThis, Symbol.for("embel.account-http.runtime.v1"), { value: legacy, configurable: true });
    expect(startAccountHttpBindingSource({ ...environment, EMBEL_ACCOUNT_HTTP_SOURCE_CONFIG: "invalid private token" })).toBe("unavailable");
    const lease = await acquireAccountIdentityRuntime(harness().auth()); expect(lease).toMatchObject({ configured: true, value: null }); expect(legacy.resolveIdentity).not.toHaveBeenCalled();
  });
  it("preserves legacy fallback only when dynamic configuration is disabled", async () => {
    const value = { transactions: {}, saveAvailability: { status: "available" } }, legacy = { resolveIdentity: vi.fn(async () => value) };
    Object.defineProperty(globalThis, Symbol.for("embel.account-http.runtime.v1"), { value: legacy, configurable: true });
    expect(startAccountHttpBindingSource({ EMBEL_ACCOUNT_HTTP_SOURCE_ENABLED: "false" })).toBe("disabled");
    expect(await acquireAccountIdentityRuntime(harness().auth())).toMatchObject({ configured: false, value });
  });
  it("releases the Home runtime in finally after an operation fails", async () => {
    const h = harness(1);
    expect(startAccountHttpBindingSource(environment, { createSource: () => h.source, createRuntime: h.createRuntime })).toBe("installed");
    await expect(stageHomeAttachment(h.auth(), { requestKey: randomUUID(), name: "brief.txt", mimeType: "text/plain", contentHash: "a".repeat(64) }, new Uint8Array([1])))
      .rejects.toMatchObject({ code: "integration_unavailable" });
    // With a leaked lease, this generation change would retain the prior entry
    // in use. The released entry is closed before constructing its replacement.
    const next = fixtureRecord(ownerA, 101, 2, 2); h.records.set(ownerA, next); h.authorities.set(ownerA, snapshot(next));
    const lease = await acquireAccountIdentityRuntime(h.auth()); expect(lease.value).not.toBeNull(); expect(h.prepared[0]!.runtime.close).toHaveBeenCalledTimes(1); await lease.release();
  });
});
