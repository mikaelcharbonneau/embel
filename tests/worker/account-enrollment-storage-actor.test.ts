import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createVaultStorageActorProvisioner } from "../../worker/account-enrollment/storage-actor";
import { readApprovedWorkerProfiles } from "../../worker/account-enrollment/configuration";
import { IMAGE_MODEL } from "../../src/domain/providers";
import type { EnrollmentContext } from "../../src/server/account-enrollment/contracts";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const origin = "https://fricsfwqibyhemknqgyf.supabase.co";
const profile = readApprovedWorkerProfiles([{ profileId: "approved-logo", providerBindingRef: "providers/logo", modelVerificationReceipt: "receipt:logo",
  applicationOrigin: "https://www.embel.xyz", supabaseOrigin: origin, projectId: "prj_1234567890ab", deploymentId: "dpl_qualified", sourceRevision: "a".repeat(40),
  artifactSha256: "b".repeat(64), managedProofSha256: "c".repeat(64), runtime: { node: "22.22.2", icu: "77.1", unicode: "16.0", platform: "linux", arch: "x64" },
  dispatchApproved: true, capability: "logo", model: IMAGE_MODEL, admissionContract: "account_logo_operation", spendControl: "uncapped",
  policyIdentities: { "identity.logo_concept": "d".repeat(64), "identity.logo_refine": "d".repeat(64) }, storageIdentityRef: "storage/logo" }]).get("logo")!;
const configuration = { vault: { origin: "https://vault.example", mount: "actors", token: "fixture-operator-vault-token" }, reservationPrefix: "operator-actors",
  supabaseOrigin: origin, adminKey: "fixture-explicit-admin-key-not-live", publishableKey: "sb_publishable_fixture", emailDomain: "actors.example" };
type FixtureUser = { id: string; email: string; role: string; is_anonymous: false; app_metadata: Record<string, unknown>; email_confirmed_at?: string; banned_until?: string };
function fixture() {
  const records = new Map<string, { data: Record<string, unknown>; version: number }>(), users = new Map<string, FixtureUser>();
  const events: string[] = [], destroyed: { ref: string; versions: number[] }[] = [];
  let loseVaultWrite = false, loseCreate = false, rejectRegistration = false, rejectRetirement = false, foreignMetadata = false, foreignSession = false;
  let oversized = false, redirect = false, failLogout = false, reordered = false, losePublication = false, loseBan = false, expireAtRegistration = false;
  let banReadback: "missing" | "expired" | "invalid" | undefined, ignoreBan = false;
  let neverProvisioned = false, noSessions = true, noRefresh = true, foreignProof = false, lostConfirmation = false;
  let rejectSqlReserve = false, loseSqlReserve = false, lostRetired = false;
  const registered = new Set<string>();
  const sqlReservations = new Set<string>();
  function reorder(value: unknown): unknown { return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, reorder(child)])) : value; }
  const step = { capability: "logo" as const, operationKey, phase: "provisioning" as const, effectsStarted: true,
    credentialRef: null, publicationReceipt: null, verificationReceipt: null };
  const context: EnrollmentContext = { claim: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ownerId, generation: 1, revision: 2,
    leaseToken: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", leaseUntil: new Date(Date.now() + 60_000).toISOString(), mode: "enroll", steps: [step] }, step,
    store: {} as EnrollmentContext["store"] };
  context.store.read = vi.fn(async () => context.claim);
  Object.assign(context.store, { operator: { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    const reserving = sql.includes("reserve_account_worker_storage_actor"), never = sql.includes("prove_unprovisioned_account_worker_storage_actor");
    const retiring = sql.includes("revoke_account_worker_storage_actor") || never;
    events.push(reserving ? "sql-reserve" : never ? "sql-never-provisioned" : retiring ? "sql-drained" : "sql-register");
    if (neverProvisioned && retiring && !never) throw Error("fixture never had a worker binding");
    if (retiring ? rejectRetirement : !reserving && rejectRegistration) throw Error("fixture-private-SQL-error-with-secret-shaped-message");
    const actor = values![2] as string, ref = values![4] as string;
    if (never && !sqlReservations.has(actor)) {
      if (users.has(actor)) throw Error("fixture exact SQL reservation absent for existing user");
      sqlReservations.add(actor); // SQL binds only this terminal, proven-absent cleanup UUID.
    }
    if (reserving) {
      if (rejectSqlReserve) throw Error("fixture reserve unavailable"); sqlReservations.add(actor);
      if (loseSqlReserve) { loseSqlReserve = false; throw Error("fixture SQL reservation ACK lost"); }
    }
    if (!retiring && !reserving) { expect(sqlReservations.has(actor)).toBe(true); if (!registered.has(actor)) expect(users.get(actor)?.email_confirmed_at).toBeUndefined(); registered.add(actor);
      expect(values![0]).toBe(context.claim.id); expect(values![1]).toBe(context.claim.leaseToken); if (expireAtRegistration) context.claim.leaseUntil = new Date(0).toISOString(); }
    return { rows: [{ value: { ownerId: foreignProof ? "11111111-1111-4111-8111-111111111111" : ownerId, generation: context.claim.generation, revision: context.claim.revision, operationKey: context.step.operationKey,
      authUserId: actor, storageIdentityRef: "storage/logo", receipt: retiring ? "receipt:worker-drained" : ref,
      ...(never ? { receipt: ref, scope: "never_provisioned", authorityAbsent: true, storageDenied: true, authUserAbsent: !users.has(actor),
        registered: registered.has(actor), sessionsAbsent: noSessions, refreshTokensAbsent: noRefresh }
        : retiring ? { runtimeStopped: true, storageDenied: true } : {}) } }] };
  }) } });
  const transport = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(raw)); expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit"); expect(init?.cache).toBe("no-store");
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.origin === "https://vault.example") {
      const match = /^\/v1\/actors\/(data|destroy)\/(.+)$/u.exec(url.pathname)!;
      const ref = match[2]!.split("/").map(decodeURIComponent).join("/");
      if (method === "GET") { const stored = records.get(ref); return stored ? Response.json({ data: { data: reordered ? reorder(stored.data) : stored.data, metadata: { version: stored.version } } }) : new Response(null, { status: 404 }); }
      if (match[1] === "destroy") { destroyed.push({ ref, versions: body.versions }); events.push("destroy-history"); return new Response(null, { status: 204 }); }
      const old = records.get(ref); if ((old?.version ?? 0) !== body.options.cas) return Response.json({ errors: ["check-and-set parameter did not match the current version"] }, { status: 400 });
      records.set(ref, { data: body.data, version: (old?.version ?? 0) + 1 }); events.push(ref.startsWith("operator-actors/") ? "vault-reservation" : "vault-publication");
      if (loseVaultWrite) { loseVaultWrite = false; throw Error("fixture-private-vault-write-ack"); }
      if (losePublication && ref.startsWith("storage/logo/")) { losePublication = false; throw Error("fixture-private-publication-ack"); }
      if (lostRetired && body.data.phase === "retired") { lostRetired = false; throw Error("fixture retired tombstone ACK lost"); }
      return Response.json({ data: { version: (old?.version ?? 0) + 1 } });
    }
    expect(url.origin).toBe(origin);
    if (redirect) { const response = Response.json({}); Object.defineProperty(response, "redirected", { value: true }); return response; }
    if (oversized) return new Response("x".repeat(131_073));
    const headers = new Headers(init?.headers);
    if (url.pathname.startsWith("/auth/v1/admin/") || url.pathname === "/auth/v1/logout" && url.searchParams.get("scope") === "global") expect(headers.get("apikey")).toBe(configuration.adminKey);
    else expect(headers.get("apikey")).toBe(configuration.publishableKey);
    if (url.pathname === "/auth/v1/admin/users" && method === "POST") {
      events.push("auth-create-unconfirmed"); expect(body.email_confirm).toBe(false); expect(body.role).toBe("authenticated");
      expect(sqlReservations.has(body.id)).toBe(true);
      expect(records.size).toBeGreaterThan(0); const reserved = [...records.values()][0]!.data; expect(reserved.authUserId).toBe(body.id); expect(reserved.password).toBe(body.password);
      if (users.has(body.id)) return Response.json({ code: "user_already_exists", msg: "fixture duplicate UUID" }, { status: 422 });
      const user: FixtureUser = { id: body.id, email: body.email, role: body.role, is_anonymous: false, app_metadata: body.app_metadata };
      if (foreignMetadata) user.app_metadata = { embel_worker_storage: { ownerId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } };
      users.set(user.id, user); if (loseCreate) { loseCreate = false; throw Error("fixture-private-auth-create-ack"); } return Response.json(user);
    }
    if (url.pathname.startsWith("/auth/v1/admin/users/")) {
      const user = users.get(url.pathname.split("/").at(-1)!);
      if (!user) return Response.json({ code: "user_not_found", msg: "fixture missing user" }, { status: 404 });
      if (method === "GET") {
        events.push(user.banned_until ? "auth-read-banned-uuid" : "auth-get-known-uuid");
        const observed = { ...user };
        if (banReadback === "missing") delete observed.banned_until;
        if (banReadback === "expired") observed.banned_until = new Date(0).toISOString();
        if (banReadback === "invalid") observed.banned_until = "fixture-not-a-timestamp";
        return Response.json(reordered ? reorder(observed) : observed);
      }
      if (body.email_confirm) { events.push("auth-confirm"); expect(events).toContain("sql-register"); user.email_confirmed_at = new Date().toISOString();
        if (lostConfirmation) { lostConfirmation = false; throw Error("fixture confirmation ACK lost"); } }
      if (body.ban_duration) { events.push("auth-ban"); expect(events.some(event => event === "sql-drained" || event === "sql-never-provisioned")).toBe(true);
        if (ignoreBan) return Response.json({ ...user, banned_until: "2126-01-01T00:00:00Z" });
        user.banned_until = "2126-01-01T00:00:00Z";
        if (loseBan) { loseBan = false; throw Error("fixture-private-ban-ack"); } }
      return Response.json(reordered ? reorder(user) : user);
    }
    const user = [...users.values()][0]!;
    if (url.pathname === "/auth/v1/token") {
      events.push("auth-password-session"); expect(user.email_confirmed_at).toBeTruthy(); expect(body.email).toBe(user.email);
      const subject = foreignSession ? ownerId : user.id;
      const claims = { sub: subject, role: "authenticated", aud: "authenticated", iss: `${origin}/auth/v1`, is_anonymous: false,
        session_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", exp: Math.floor(Date.now() / 1000) + 3600 };
      const token = [Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url"), "fixture"].join(".");
      return Response.json({ access_token: token, refresh_token: "fixture-refresh-memory-only", expires_in: 3600, token_type: "bearer", user: { ...user, id: subject } });
    }
    if (url.pathname === "/auth/v1/user") { events.push("auth-verify-session"); return Response.json(reordered ? reorder(user) : user); }
    if (url.pathname === "/auth/v1/logout") { events.push(`auth-logout-${url.searchParams.get("scope")}`); if (failLogout) return Response.json({ msg: "fixture-private-logout-error" }, { status: 500 }); return new Response(null, { status: 204 }); }
    throw Error("Unexpected fixture request");
  });
  vi.stubGlobal("fetch", transport);
  return { context, records, users, events, destroyed, transport, input: { context, profile },
    loseVault() { loseVaultWrite = true; }, loseAuthCreate() { loseCreate = true; }, rejectRegistration() { rejectRegistration = true; },
    allowRegistration() { rejectRegistration = false; }, rejectRetirement() { rejectRetirement = true; }, foreignMetadata() { foreignMetadata = true; },
    foreignSession() { foreignSession = true; }, oversize() { oversized = true; }, redirect() { redirect = true; }, failLogout() { failLogout = true; },
    banReadback(mode: "missing" | "expired" | "invalid") { banReadback = mode; },
    ignoreBan() { ignoreBan = true; },
    neverProvisioned() { neverProvisioned = true; }, sessionsPresent() { noSessions = false; }, refreshPresent() { noRefresh = false; },
    foreignProof() { foreignProof = true; }, loseConfirmation() { lostConfirmation = true; }, rejectSqlReserve() { rejectSqlReserve = true; },
    loseSqlReserve() { loseSqlReserve = true; }, loseRetired() { lostRetired = true; },
    reorderKeys() { reordered = true; }, losePublication() { losePublication = true; }, loseBan() { loseBan = true; }, expireAtRegistration() { expireAtRegistration = true; } };
}
afterEach(() => { vi.unstubAllGlobals(); });
describe("optional Storage actor provisioner (all Auth/Vault HTTP and SQL are memory fixtures)", () => {
  it("is explicit/default unavailable and does no I/O during construction", () => {
    const f = fixture(); expect(() => createVaultStorageActorProvisioner({})).toThrow(); createVaultStorageActorProvisioner(configuration); expect(f.transport).not.toHaveBeenCalled();
    expect(() => createVaultStorageActorProvisioner({ ...configuration, reservationPrefix: "storage/logo" })).not.toThrow();
  });
  it("reserves UUID/password before unconfirmed creation, registers before confirmation and verifies an ordinary session", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration), record = await actor.ensure(f.input);
    expect(f.events.indexOf("vault-reservation")).toBeLessThan(f.events.indexOf("auth-create-unconfirmed"));
    expect(f.events.indexOf("vault-reservation")).toBeLessThan(f.events.indexOf("sql-reserve"));
    expect(f.events.indexOf("sql-reserve")).toBeLessThan(f.events.indexOf("auth-create-unconfirmed"));
    expect(f.events.indexOf("sql-register")).toBeLessThan(f.events.indexOf("auth-confirm"));
    expect(f.events.indexOf("auth-verify-session")).toBeLessThan(f.events.indexOf("vault-publication"));
    expect(f.events).toContain("auth-logout-local"); expect(f.events).not.toContain("auth-logout-global");
    expect(record.storage.authUserId).not.toBe(ownerId); expect(record.storage.identity.password).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(record.storage.sessionApproved).toBe(true); expect(JSON.stringify([...f.records.values()])).not.toContain(configuration.adminKey);
    expect(JSON.stringify([...f.records.values()])).not.toContain("fixture-refresh-memory-only");
    expect(f.transport.mock.calls.some(([url]) => new URL(String(url)).pathname === "/auth/v1/admin/users" && new URL(String(url)).search)).toBe(false);
  });
  it("recovers a lost durable reservation ACK without creating any earlier Auth account", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.loseVault();
    await expect(actor.ensure(f.input)).rejects.toMatchObject({ uncertain: true }); expect(f.users.size).toBe(0);
    const uuid = [...f.records.values()][0]!.data.authUserId; const recovered = await actor.ensure(f.input);
    expect(recovered.storage.authUserId).toBe(uuid); expect(f.users.size).toBe(1);
  });
  it("recovers a lost create ACK only by the durably known UUID and never lists accounts", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.loseAuthCreate();
    const record = await actor.ensure(f.input); expect(f.users.size).toBe(1); expect(record.storage.authUserId).toBe([...f.users.keys()][0]);
    expect(f.events.filter(event => event === "auth-create-unconfirmed")).toHaveLength(1);
    expect(f.transport.mock.calls.filter(([url, init]) => String(url) === `${origin}/auth/v1/admin/users` && init?.method === "GET")).toHaveLength(0);
  });
  it("keeps a newly created actor unconfirmed and unpublished when SQL registration is unavailable", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.rejectRegistration();
    await expect(actor.ensure(f.input)).rejects.toThrow("Account enrollment effect is unavailable");
    expect([...f.users.values()][0]!.email_confirmed_at).toBeUndefined(); expect(f.events).not.toContain("auth-confirm"); expect(f.events).not.toContain("vault-publication");
    f.allowRegistration(); await actor.ensure(f.input); expect(f.events.filter(event => event === "auth-create-unconfirmed")).toHaveLength(1);
  });
  it("treats real JSON object key reordering as equal on repeated post-confirmation recovery", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.reorderKeys();
    const first = await actor.ensure(f.input), second = await actor.ensure(f.input); expect(second).toEqual(first);
    expect(f.users.size).toBe(1); expect(f.events.filter(event => event === "auth-create-unconfirmed")).toHaveLength(1);
  });
  it.each(["2126-01-01T00:00:00Z", "fixture-invalid-ban-timestamp"])("does not renew SQL approval or mutate an already banned/invalid actor (%s)", async bannedUntil => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration), record = await actor.ensure(f.input);
    f.users.get(record.storage.authUserId)!.banned_until = bannedUntil;
    const before = f.events.length, versions = [...f.records.values()].map(record => record.version);
    await expect(actor.ensure(f.input)).rejects.toMatchObject({ uncertain: true });
    expect(f.events.slice(before)).not.toContain("sql-register"); expect(f.events.slice(before)).not.toContain("auth-confirm");
    expect(f.events.slice(before)).not.toContain("auth-password-session"); expect(f.events.slice(before)).not.toContain("vault-publication");
    expect([...f.records.values()].map(record => record.version)).toEqual(versions); expect(f.users.size).toBe(1);
    expect(f.users.get(record.storage.authUserId)!.banned_until).toBe(bannedUntil);
  });
  it("renews SQL approval for an existing same-UUID actor whose old ban has expired", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration), record = await actor.ensure(f.input);
    f.users.get(record.storage.authUserId)!.banned_until = new Date(0).toISOString(); const before = f.events.length;
    const renewed = await actor.ensure(f.input); expect(renewed.storage.authUserId).toBe(record.storage.authUserId);
    expect(f.events.slice(before).filter(event => event === "sql-register")).toHaveLength(1); expect(f.users.size).toBe(1);
  });
  it.each(["missing", "wrong"])("never creates credentials or reaches Auth/SQL effects for %s maintenance reservation", async defect => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration), record = await actor.ensure(f.input);
    if (defect === "missing") for (const key of f.records.keys()) if (key.startsWith("operator-actors/")) f.records.delete(key);
    const calls = f.transport.mock.calls.length, before = f.events.length, versions = [...f.records.values()].map(record => record.version);
    await expect(actor.ensure({ ...f.input, expectedAuthUserId: defect === "wrong" ? "11111111-1111-4111-8111-111111111111" : record.storage.authUserId })).rejects.toThrow();
    expect(f.events.slice(before)).toEqual([]); expect([...f.records.values()].map(record => record.version)).toEqual(versions); expect(f.users.size).toBe(1);
    expect(f.transport.mock.calls.slice(calls).every(([url, init]) => new URL(String(url)).origin === "https://vault.example" && init?.method === "GET")).toBe(true);
  });
  it("recovers a lost approved-record ACK without changing the actor or exposing an admin key", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.losePublication();
    await expect(actor.ensure(f.input)).rejects.toMatchObject({ uncertain: true }); const original = [...f.users.keys()][0];
    const recovered = await actor.ensure(f.input); expect(recovered.storage.authUserId).toBe(original); expect(f.users.size).toBe(1);
    expect(JSON.stringify(recovered)).not.toContain(configuration.adminKey);
  });
  it("serializes competing UUID reservations through CAS before either Auth mutation", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration);
    const results = await Promise.allSettled([actor.ensure(f.input), actor.ensure(f.input)]);
    expect(f.users.size).toBe(1); expect(results.some(result => result.status === "fulfilled")).toBe(true);
    const actorIds = [...f.records.values()].filter(record => record.data.password).map(record => record.data.authUserId);
    expect(new Set(actorIds).size).toBe(1);
  });
  it("rechecks the live lease after registry approval before confirming the actor", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.expireAtRegistration();
    await expect(actor.ensure(f.input)).rejects.toThrow(); expect(f.events).toContain("sql-register"); expect(f.events).not.toContain("auth-confirm");
    expect([...f.users.values()][0]!.email_confirmed_at).toBeUndefined();
  });
  it.each(["expired", "unmarked", "aborted", "namespace"])("rejects %s authority before HTTP effects", async mode => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(mode === "namespace" ? { ...configuration, reservationPrefix: "storage/logo" } : configuration);
    if (mode === "expired") f.context.claim.leaseUntil = new Date(0).toISOString(); if (mode === "unmarked") f.context.step.effectsStarted = false;
    await expect(actor.ensure(f.input, mode === "aborted" ? AbortSignal.abort() : undefined)).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(["metadata", "session", "oversize", "redirect", "logout"])("fails closed for %s and redacts private error details", async mode => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration);
    if (mode === "metadata") f.foreignMetadata(); if (mode === "session") f.foreignSession(); if (mode === "oversize") f.oversize(); if (mode === "redirect") f.redirect(); if (mode === "logout") f.failLogout();
    const error = await actor.ensure(f.input).then(() => null, error => error);
    expect(error?.message).toBe("Account enrollment effect is unavailable"); expect(f.events).not.toContain("vault-publication");
  });
  it("requires SQL drain/Storage-denial proof before any global logout or ban", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); await actor.ensure(f.input);
    f.context.claim.mode = "revoke"; f.context.claim.revision++; f.rejectRetirement(); const before = f.events.length;
    await expect(actor.revoke(f.input)).rejects.toThrow();
    expect(f.events.slice(before)).not.toContain("auth-password-session"); expect(f.events).not.toContain("auth-logout-global"); expect(f.events).not.toContain("auth-ban");
  });
  it("retires the original actor under a newer revoke revision, globally logs out then bans and destroys credential histories", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); const record = await actor.ensure(f.input);
    f.context.claim.mode = "revoke"; f.context.claim.revision++; f.context.claim.generation++;
    f.context.step.operationKey = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await actor.revoke(f.input); await actor.revoke(f.input);
    expect(f.events.indexOf("sql-drained")).toBeLessThan(f.events.indexOf("auth-logout-global"));
    expect(f.events.indexOf("auth-logout-global")).toBeLessThan(f.events.indexOf("auth-ban"));
    expect(f.events.indexOf("auth-ban")).toBeLessThan(f.events.indexOf("auth-read-banned-uuid"));
    expect(f.events.indexOf("auth-read-banned-uuid")).toBeLessThan(f.events.indexOf("destroy-history"));
    expect(f.events.filter(event => event === "auth-logout-global")).toHaveLength(1);
    expect(f.records.get(`storage/logo/${ownerId}`)?.data).toMatchObject({ retired: true, authUserId: record.storage.authUserId, storage: null });
    expect([...f.records.values()].find(value => value.data.phase === "retired")?.data.password).toBeNull();
    expect(f.destroyed.some(entry => entry.ref.startsWith("operator-actors/") && entry.versions.includes(1))).toBe(true);
    expect(f.destroyed.some(entry => entry.ref.startsWith("storage/logo/") && entry.versions.includes(1))).toBe(true);
  });
  it.each(["phase", "ban"])("recovers a lost retirement %s acknowledgement without needing another usable login", async mode => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); await actor.ensure(f.input);
    f.context.claim.mode = "revoke"; f.context.claim.revision++; if (mode === "phase") f.loseVault(); else f.loseBan();
    await expect(actor.revoke(f.input)).rejects.toMatchObject({ uncertain: true }); await actor.revoke(f.input);
    expect(f.events.filter(event => event === "auth-logout-global")).toHaveLength(1);
    expect(f.events.filter(event => event === "auth-ban")).toHaveLength(1);
    expect(f.records.get(`storage/logo/${ownerId}`)?.data.storage).toBeNull();
  });
  it.each(["missing", "expired", "invalid"] as const)("requires fresh future ban readback (%s cannot retire or destroy credential history)", async mode => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); await actor.ensure(f.input);
    f.context.claim.mode = "revoke"; f.context.claim.revision++; f.banReadback(mode);
    await expect(actor.revoke(f.input)).rejects.toMatchObject({ uncertain: true });
    expect(f.events).toContain("auth-ban"); expect(f.destroyed).toHaveLength(0);
    const reservation = [...f.records.values()].find(value => value.data.phase === "sessions_revoked");
    expect(reservation?.data.password).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(f.records.get(`storage/logo/${ownerId}`)?.data.storage).not.toBeNull();
    expect([...f.records.values()].some(value => value.data.phase === "retired")).toBe(false);
  });
  it("rejects a 200 ban acknowledgement when a fresh known-UUID read shows the ban was not applied", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); await actor.ensure(f.input);
    f.context.claim.mode = "revoke"; f.context.claim.revision++; f.ignoreBan();
    await expect(actor.revoke(f.input)).rejects.toMatchObject({ uncertain: true });
    expect([...f.users.values()][0]!.banned_until).toBeUndefined(); expect(f.destroyed).toHaveLength(0);
    expect([...f.records.values()].some(value => value.data.phase === "retired")).toBe(false);
    expect(f.records.get(`storage/logo/${ownerId}`)?.data.storage).not.toBeNull();
  });
  it("does not issue Admin create before the exact durable SQL reservation is acknowledged", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.rejectSqlReserve();
    await expect(actor.ensure(f.input)).rejects.toThrow(); expect(f.records.size).toBe(1); expect(f.users.size).toBe(0);
    expect(f.events).not.toContain("auth-create-unconfirmed");
  });
  it("retires an Auth-absent reservation after a lost SQL reservation ACK using explicit absence proof", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.loseSqlReserve();
    await expect(actor.ensure(f.input)).rejects.toThrow(); expect(f.users.size).toBe(0);
    f.context.claim.mode = "revoke"; f.context.claim.revision++; f.neverProvisioned();
    await actor.revoke(f.input); await actor.revoke(f.input);
    expect(f.events).toContain("sql-never-provisioned"); expect(f.events).not.toContain("auth-password-session"); expect(f.events).not.toContain("auth-ban");
    expect(f.records.get(`storage/logo/${ownerId}`)?.data).toMatchObject({ retired: true, storage: null });
    expect([...f.records.values()].find(value => value.data.phase === "retired")?.data.password).toBeNull();
  });
  it("cleans a Vault-only reservation only after SQL independently proves Auth absence and terminally binds the UUID", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.loseVault();
    await expect(actor.ensure(f.input)).rejects.toThrow(); f.context.claim.mode = "revoke"; f.context.claim.revision++; f.neverProvisioned();
    await actor.revoke(f.input); expect(f.users.size).toBe(0); expect(f.events).toContain("sql-never-provisioned");
    expect(f.events).not.toContain("auth-create-unconfirmed"); expect(f.events).not.toContain("auth-ban");
    expect([...f.records.values()].find(value => value.data.phase === "retired")?.data.password).toBeNull();
  });
  it("cleans a created unconfirmed unregistered actor without inventing a password session or process exit", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.rejectRegistration();
    await expect(actor.ensure(f.input)).rejects.toThrow(); const user = [...f.users.values()][0]!;
    expect(user.email_confirmed_at).toBeUndefined(); f.context.claim.mode = "revoke"; f.context.claim.revision++; f.neverProvisioned();
    await actor.revoke(f.input); expect(f.events).toContain("sql-never-provisioned"); expect(f.events).not.toContain("auth-password-session");
    expect(f.events).not.toContain("auth-logout-global"); expect(user.banned_until).toBeTruthy(); expect(f.destroyed.length).toBeGreaterThan(0);
  });
  it("globally revokes a confirmed actor after a lost confirmation ACK before publication", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.loseConfirmation();
    await expect(actor.ensure(f.input)).rejects.toThrow(); expect([...f.users.values()][0]!.email_confirmed_at).toBeTruthy();
    expect(f.records.has(`storage/logo/${ownerId}`)).toBe(false); f.context.claim.mode = "revoke"; f.context.claim.revision++; f.neverProvisioned();
    await actor.revoke(f.input); expect(f.events).toContain("auth-logout-global"); expect(f.events).toContain("auth-ban");
  });
  it("uses SQL never-provisioned proof for an approved pointer that never acquired a worker binding", async () => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); await actor.ensure(f.input);
    f.context.claim.mode = "revoke"; f.context.claim.revision++; f.neverProvisioned();
    await actor.revoke(f.input); expect(f.events).toContain("sql-never-provisioned"); expect(f.events).toContain("auth-logout-global");
  });
  it.each(["foreign", "sessions", "refresh"])("refuses a never-provisioned cleanup with %s proof defect", async defect => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.rejectRegistration();
    await expect(actor.ensure(f.input)).rejects.toThrow(); f.context.claim.mode = "revoke"; f.context.claim.revision++; f.neverProvisioned();
    if (defect === "foreign") f.foreignProof(); if (defect === "sessions") f.sessionsPresent(); if (defect === "refresh") f.refreshPresent();
    await expect(actor.revoke(f.input)).rejects.toThrow(); expect(f.events).not.toContain("auth-ban"); expect(f.destroyed).toHaveLength(0);
  });
  it.each(["ban", "retired", "pointer"])("recovers lost %s ACK during unconfirmed orphan retirement", async stage => {
    const f = fixture(), actor = createVaultStorageActorProvisioner(configuration); f.rejectRegistration();
    await expect(actor.ensure(f.input)).rejects.toThrow(); f.context.claim.mode = "revoke"; f.context.claim.revision++; f.neverProvisioned();
    if (stage === "ban") f.loseBan(); if (stage === "retired") f.loseRetired(); if (stage === "pointer") f.losePublication();
    await expect(actor.revoke(f.input)).rejects.toThrow(); await actor.revoke(f.input);
    expect(f.events.filter(event => event === "auth-ban")).toHaveLength(1); expect(f.events).not.toContain("auth-password-session");
    expect(f.records.get(`storage/logo/${ownerId}`)?.data.storage).toBeNull();
  });
});
