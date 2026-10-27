import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createClient, type User } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { z } from "zod";
import { EnrollmentEffectUnavailable, type EnrollmentContext } from "../../src/server/account-enrollment/contracts";
import { approvedWorkerProfileSchema, type ApprovedWorkerProfile } from "./configuration";
import { createEnrollmentVaultClient } from "./vault-client";

const origin = "https://fricsfwqibyhemknqgyf.supabase.co";
const unavailable = (uncertain = false) => new EnrollmentEffectUnavailable("store_unavailable", uncertain);
const configurationSchema = z.strictObject({ vault: z.unknown(), reservationPrefix: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_/-]{0,39}$/u),
  supabaseOrigin: z.literal(origin), adminKey: z.string().min(20).max(8192),
  publishableKey: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{1,500}$/u),
  emailDomain: z.string().max(190).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u) });
const reservationSchema = z.strictObject({ version: z.literal(1), ownerId: z.uuid(), generation: z.number().int().positive(), revision: z.number().int().positive(),
  operationKey: z.uuid(), storageIdentityRef: z.string(), authUserId: z.uuid(), email: z.email().max(254), password: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).nullable(),
  phase: z.enum(["reserved", "approved", "sessions_revoked", "retired"]) });
type Reservation = z.infer<typeof reservationSchema>;
export type StorageActorRecord = Readonly<{ version: 1; ownerId: string; storageIdentityRef: string; storage: {
  authUserId: string; publishableKey: string; sessionApproved: true;
  identity: { version: 1; ownerId: string; authUserId: string; email: string; password: string };
} }>;
type ActorInput = { context: EnrollmentContext; profile: ApprovedWorkerProfile; expectedAuthUserId?: string };
const proofSchema = z.strictObject({ ownerId: z.uuid(), generation: z.number().int().positive(), revision: z.number().int().positive(), operationKey: z.uuid(),
  authUserId: z.uuid(), storageIdentityRef: z.string(), receipt: z.string().min(1).max(200) });
export type StorageActorRetirementProof = z.infer<typeof proofSchema> & { runtimeStopped: true; storageDenied: true };
export type StorageActorProvisioner = {
  ensure(input: ActorInput, signal?: AbortSignal): Promise<StorageActorRecord>;
  revoke(input: ActorInput, signal?: AbortSignal): Promise<void>;
};

/** Optional operator-only Auth authority. Construction performs no I/O and does
 * not discover credentials. Admin access must be separately approved/configured;
 * the admin key and reservation namespace must never reach a worker/read token.
 * Retirement requires lease-bound SQL drain/Storage-denial proof or an explicit
 * never-provisioned authority/session absence proof, without inventing an exit.
 */
export function createVaultStorageActorProvisioner(raw: unknown, dependencies: {
  fetch?: typeof fetch;
} = {}): StorageActorProvisioner {
  const parsed = configurationSchema.safeParse(raw);
  if (!parsed.success || parsed.data.reservationPrefix.split("/").some(part => !part || part === "." || part === "..")) throw unavailable();
  const config = parsed.data, vault = createEnrollmentVaultClient(config.vault), transport = dependencies.fetch ?? globalThis.fetch;

  function validate(input: ActorInput, mode: "enroll" | "revoke", signal?: AbortSignal) {
    signal?.throwIfAborted();
    const profile = approvedWorkerProfileSchema.parse(input.profile), { context } = input;
    if (input.expectedAuthUserId !== undefined && (!z.uuid().safeParse(input.expectedAuthUserId).success || input.expectedAuthUserId === context.claim.ownerId)) throw unavailable();
    if (profile.capability !== "logo" || context.step.capability !== "logo" || context.claim.mode !== mode || !context.step.effectsStarted
      || Date.parse(context.claim.leaseUntil) <= Date.now() || profile.supabaseOrigin !== config.supabaseOrigin) throw unavailable();
    if (`${config.reservationPrefix}/`.startsWith(`${profile.storageIdentityRef}/`) || `${profile.storageIdentityRef}/`.startsWith(`${config.reservationPrefix}/`)) throw unavailable();
    return { profile, ref: `${config.reservationPrefix}/${context.claim.ownerId}/${context.claim.generation}/logo/${context.step.operationKey}` };
  }
  async function fresh(input: ActorInput, mode: "enroll" | "revoke", signal?: AbortSignal) {
    validate(input, mode, signal);
    const expected = input.context, claim = await expected.store.read(expected.claim);
    const step = claim.steps.find(step => step.capability === "logo");
    if (claim.id !== expected.claim.id || claim.ownerId !== expected.claim.ownerId || claim.generation !== expected.claim.generation || claim.revision !== expected.claim.revision
      || claim.mode !== mode || claim.leaseToken !== expected.claim.leaseToken || Date.parse(claim.leaseUntil) <= Date.now()
      || !step?.effectsStarted || step.operationKey !== expected.step.operationKey) throw unavailable();
    signal?.throwIfAborted();
  }
  function readReservation(value: unknown, input: ActorInput, storageIdentityRef: string, original = false) {
    const result = reservationSchema.parse(value), { claim, step } = input.context;
    if (result.ownerId !== claim.ownerId || (original ? result.generation > claim.generation || result.revision > claim.revision :
      result.generation !== claim.generation || result.revision !== claim.revision || result.operationKey !== step.operationKey)
      || result.storageIdentityRef !== storageIdentityRef || result.authUserId === claim.ownerId || result.email !== `${result.authUserId}@${config.emailDomain}`) throw unavailable(true);
    return result;
  }
  function metadata(input: ActorInput, value: Reservation, ref: string) {
    return { version: 1, enrollmentId: input.context.claim.id, ownerId: value.ownerId, generation: value.generation,
      operationKey: value.operationKey, storageIdentityRef: value.storageIdentityRef, reservationRef: ref };
  }
  function checkUser(user: User | null, input: ActorInput, value: Reservation, ref: string) {
    if (!user || user.id !== value.authUserId || user.email !== value.email || user.role !== "authenticated" || user.is_anonymous !== false
      || !isDeepStrictEqual(user.app_metadata?.embel_worker_storage, metadata(input, value, ref))) throw unavailable(true);
    return user;
  }
  function checkEnrollmentUser(user: User | null, input: ActorInput, value: Reservation, ref: string) {
    const checked = checkUser(user, input, value, ref), ban = checked.banned_until;
    if (ban != null && ban !== "" && (typeof ban !== "string" || !Number.isFinite(Date.parse(ban)) || Date.parse(ban) > Date.now())) throw unavailable();
    return checked;
  }
  function clients(value: Pick<Reservation, "authUserId">, signal?: AbortSignal) {
    const routes = new Map([
      [`${origin}/auth/v1/admin/users/${value.authUserId}`, new Set(["GET", "PUT"])],
      [`${origin}/auth/v1/admin/users`, new Set(["POST"])],
      [`${origin}/auth/v1/token?grant_type=password`, new Set(["POST"])],
      [`${origin}/auth/v1/user`, new Set(["GET"])],
      [`${origin}/auth/v1/logout?scope=global`, new Set(["POST"])],
      [`${origin}/auth/v1/logout?scope=local`, new Set(["POST"])],
    ]);
    const safeFetch: typeof fetch = async (input, init) => {
      const url = String(input), method = init?.method ?? "GET";
      if (!routes.get(url)?.has(method)) throw unavailable();
      const deadline = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]);
      let response: Response | undefined;
      try {
        response = await transport(url, { ...init, signal: deadline, redirect: "error", cache: "no-store", credentials: "omit" });
        if (response.redirected || response.url && response.url !== url) throw unavailable(method !== "GET");
        if (!response.body) return new Response(null, { status: response.status });
        const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
        try { while (true) { deadline.throwIfAborted(); const next = await reader.read(); deadline.throwIfAborted(); if (next.done) break;
          size += next.value.length; if (size > 131_072) throw unavailable(method !== "GET"); parts.push(next.value); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return new Response(Buffer.concat(parts), { status: response.status, headers: { "content-type": "application/json" } });
      } catch { throw unavailable(method !== "GET"); }
      finally { await response?.body?.cancel().catch(() => {}); }
    };
    const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false }, global: { fetch: safeFetch } };
    return { admin: createClient(origin, config.adminKey, options).auth, ordinary: createClient(origin, config.publishableKey, options).auth };
  }
  function checkProof(raw: unknown, input: ActorInput, value: Reservation) {
    const proof = proofSchema.parse(raw);
    if (proof.ownerId !== value.ownerId || proof.generation !== input.context.claim.generation || proof.revision !== input.context.claim.revision
      || proof.operationKey !== input.context.step.operationKey || proof.authUserId !== value.authUserId || proof.storageIdentityRef !== value.storageIdentityRef) throw unavailable(true);
    return proof;
  }
  async function destroyHistory(ref: string, version: number, signal?: AbortSignal) {
    for (let first = 1; first < version; first += 100) await vault.destroy(ref, Array.from({ length: Math.min(100, version - first) }, (_, i) => first + i), signal);
  }
  return {
    async ensure(input, signal) {
      let ordinary: ReturnType<typeof clients>["ordinary"] | undefined;
      let admin: ReturnType<typeof clients>["admin"] | undefined;
      try {
        const { profile, ref } = validate(input, "enroll", signal); await fresh(input, "enroll", signal);
        let stored = await vault.read(ref, signal);
        // Maintenance may renew only the UUID already in the worker credential.
        // Missing/mismatched reservations must fail before any write/Auth call.
        if (input.expectedAuthUserId !== undefined && (!stored || stored.data.authUserId !== input.expectedAuthUserId)) throw unavailable();
        if (!stored) {
          const authUserId = randomUUID();
          const reservation: Reservation = { version: 1, ownerId: input.context.claim.ownerId, generation: input.context.claim.generation, revision: input.context.claim.revision,
            operationKey: input.context.step.operationKey, storageIdentityRef: profile.storageIdentityRef, authUserId, email: `${authUserId}@${config.emailDomain}`,
            password: randomBytes(32).toString("base64url"), phase: "reserved" };
          await vault.write(ref, 0, reservation, signal); stored = await vault.read(ref, signal);
        }
        if (!stored) throw unavailable(true);
        const value = readReservation(stored.data, input, profile.storageIdentityRef);
        if (!value.password || value.phase === "retired" || value.phase === "sessions_revoked") throw unavailable();
        const auth = clients(value, signal); ordinary = auth.ordinary; admin = auth.admin;
        await fresh(input, "enroll", signal);
        let result = await auth.admin.admin.getUserById(value.authUserId);
        if (result.error) {
          if (result.error.status !== 404) throw unavailable();
          await fresh(input, "enroll", signal);
          const reserved = await input.context.store.operator.query("select public.reserve_account_worker_storage_actor($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::text) value",
            [input.context.claim.id, input.context.claim.leaseToken, value.authUserId, JSON.stringify(profile), ref]);
          if (reserved.rows.length !== 1 || checkProof((reserved.rows[0] as { value: unknown }).value, input, value).receipt !== ref) throw unavailable(true);
          await fresh(input, "enroll", signal);
          result = await auth.admin.admin.createUser({ id: value.authUserId, email: value.email, password: value.password, email_confirm: false, role: "authenticated",
            app_metadata: { embel_worker_storage: metadata(input, value, ref) } });
          if (result.error) result = await auth.admin.admin.getUserById(value.authUserId);
        }
        checkEnrollmentUser(result.data.user, input, value, ref); if (result.error) throw unavailable(true);
        await fresh(input, "enroll", signal);
        const registered = await input.context.store.operator.query("select public.register_account_worker_storage_actor($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::text) value",
          [input.context.claim.id, input.context.claim.leaseToken, value.authUserId, JSON.stringify(profile), ref]);
        if (registered.rows.length !== 1) throw unavailable(true);
        if (checkProof((registered.rows[0] as { value: unknown }).value, input, value).receipt !== ref) throw unavailable(true);
        if (!result.data.user?.email_confirmed_at) {
          await fresh(input, "enroll", signal);
          const confirmed = await auth.admin.admin.updateUserById(value.authUserId, { email_confirm: true });
          checkEnrollmentUser(confirmed.data.user, input, value, ref); if (confirmed.error || !confirmed.data.user?.email_confirmed_at) throw unavailable(true);
        }
        await fresh(input, "enroll", signal);
        const signed = await ordinary.signInWithPassword({ email: value.email, password: value.password });
        if (signed.error || !signed.data.session) throw unavailable(true);
        const session = signed.data.session, claims = decodeJwt(session.access_token);
        if (session.user.id !== value.authUserId || claims.sub !== value.authUserId || claims.role !== "authenticated" || claims.aud !== "authenticated"
          || claims.iss !== `${origin}/auth/v1` || claims.is_anonymous !== false || !z.uuid().safeParse(claims.session_id).success
          || !Number.isSafeInteger(claims.exp) || claims.exp! * 1000 <= Date.now()) throw unavailable(true);
        const verified = await ordinary.getUser(session.access_token); checkEnrollmentUser(verified.data.user, input, value, ref); if (verified.error) throw unavailable(true);
        // Dispose the one proof session; runtime obtains/refreshes its own normal
        // session later. No access/refresh token enters either durable record.
        const loggedOut = await ordinary.signOut({ scope: "local" }); if (loggedOut.error) throw unavailable(true);
        await fresh(input, "enroll", signal);
        const record: StorageActorRecord = { version: 1, ownerId: value.ownerId, storageIdentityRef: value.storageIdentityRef, storage: {
          authUserId: value.authUserId, publishableKey: config.publishableKey, sessionApproved: true,
          identity: { version: 1, ownerId: value.ownerId, authUserId: value.authUserId, email: value.email, password: value.password } } };
        const target = `${profile.storageIdentityRef}/${value.ownerId}`, existing = await vault.read(target, signal);
        if (existing) {
          if (!isDeepStrictEqual(existing.data, record)) {
            const tombstone = z.strictObject({ version: z.literal(1), ownerId: z.literal(value.ownerId), storageIdentityRef: z.literal(value.storageIdentityRef),
              authUserId: z.uuid(), retired: z.literal(true), storage: z.null() }).safeParse(existing.data);
            if (!tombstone.success || await vault.write(target, existing.version, record, signal) === null) throw unavailable(true);
          }
        }
        else if (await vault.write(target, 0, record, signal) === null) {
          const concurrent = await vault.read(target, signal); if (!isDeepStrictEqual(concurrent?.data, record)) throw unavailable(true);
        }
        return record;
      } catch { throw unavailable(true); }
      finally { await Promise.allSettled([ordinary?.dispose(), admin?.dispose()]); }
    },
    async revoke(input, signal) {
      let ordinary: ReturnType<typeof clients>["ordinary"] | undefined;
      let admin: ReturnType<typeof clients>["admin"] | undefined;
      try {
        const { profile, ref: currentRef } = validate(input, "revoke", signal); await fresh(input, "revoke", signal);
        const target = `${profile.storageIdentityRef}/${input.context.claim.ownerId}`, published = await vault.read(target, signal);
        if (published && (published.data.ownerId !== input.context.claim.ownerId || published.data.storageIdentityRef !== profile.storageIdentityRef)) throw unavailable();
        // A crash may precede publication. Only the deterministic reservation for
        // this lease's owner/generation/operation is eligible; never list Vault.
        let ref = currentRef, stored = !published || published.data.retired === true ? await vault.read(ref, signal) : null;
        let reservation = stored ? readReservation(stored.data, input, profile.storageIdentityRef, true) : null;
        if (!published && (!reservation || reservation.generation !== input.context.claim.generation || reservation.operationKey !== input.context.step.operationKey)) throw unavailable();
        const actor = published ? published.data.retired === true ? published.data.authUserId : (published.data.storage as { authUserId?: unknown } | undefined)?.authUserId
          : reservation?.authUserId;
        const actorId = z.uuid().parse(actor);
        // Read only the known UUID; there is no account listing or email lookup.
        const auth = clients({ authUserId: actorId }, signal); ordinary = auth.ordinary; admin = auth.admin;
        const found = await auth.admin.admin.getUserById(actorId);
        const accountAbsent = found.error?.status === 404 && found.data.user === null;
        if (accountAbsent) { if (!reservation || reservation.authUserId !== actorId || published && published.data.retired !== true) throw unavailable(); }
        else {
          if (found.error || !found.data.user) throw unavailable();
          const meta = z.strictObject({ version: z.literal(1), enrollmentId: z.literal(input.context.claim.id), ownerId: z.literal(input.context.claim.ownerId),
            generation: z.number().int().positive(), operationKey: z.uuid(), storageIdentityRef: z.literal(profile.storageIdentityRef), reservationRef: z.string() })
            .parse(found.data.user.app_metadata?.embel_worker_storage);
          ref = `${config.reservationPrefix}/${input.context.claim.ownerId}/${meta.generation}/logo/${meta.operationKey}`;
          if (ref !== meta.reservationRef || meta.generation > input.context.claim.generation || !published && ref !== currentRef) throw unavailable();
          stored = await vault.read(ref, signal); if (!stored) throw unavailable();
          reservation = readReservation(stored.data, input, profile.storageIdentityRef, true);
          checkUser(found.data.user, input, reservation, ref);
        }
        if (!stored || !reservation) throw unavailable();
        const value = reservation;
        const values = [input.context.claim.id, input.context.claim.leaseToken, value.authUserId, JSON.stringify(profile), ref];
        const neverSql = "select public.prove_unprovisioned_account_worker_storage_actor($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::text) value";
        let authorized, usedNever = false;
        if (!published || accountAbsent) { usedNever = true; authorized = await input.context.store.operator.query(neverSql, values); }
        else {
          try { authorized = await input.context.store.operator.query("select public.revoke_account_worker_storage_actor($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::text) value", values); }
          catch { usedNever = true; authorized = await input.context.store.operator.query(neverSql, values); }
        }
        if (authorized.rows.length !== 1) throw unavailable();
        const proof = z.union([
          z.strictObject({ ...proofSchema.shape, runtimeStopped: z.literal(true), storageDenied: z.literal(true) }),
          z.strictObject({ ...proofSchema.shape, scope: z.literal("never_provisioned"), authorityAbsent: z.literal(true), storageDenied: z.literal(true),
            authUserAbsent: z.boolean(), registered: z.boolean(), sessionsAbsent: z.boolean(), refreshTokensAbsent: z.boolean() }),
        ])
          .parse((authorized.rows[0] as { value: unknown }).value);
        checkProof(Object.fromEntries(Object.keys(proofSchema.shape).map(key => [key, proof[key as keyof typeof proof]])), input, value);
        const never = "scope" in proof ? proof : null;
        if (usedNever !== (never !== null)) throw unavailable();
        if (never && (never.authUserAbsent !== accountAbsent || never.receipt !== ref)) throw unavailable();
        const unconfirmed = accountAbsent || !found.data.user?.email_confirmed_at;
        const skipLogout = never !== null && unconfirmed && never.sessionsAbsent && never.refreshTokensAbsent;
        if (accountAbsent && !skipLogout || never && unconfirmed && !skipLogout) throw unavailable();
        async function readActor() {
          const observed = await auth.admin.admin.getUserById(value.authUserId);
          if (accountAbsent && observed.error?.status === 404 && observed.data.user === null) return null;
          if (observed.error) throw unavailable(true);
          return checkUser(observed.data.user, input, value, ref);
        }
        const hasLiveBan = (user: User) => typeof user.banned_until === "string" && Number.isFinite(Date.parse(user.banned_until))
          && Date.parse(user.banned_until) > Date.now();
        let version = stored.version;
        if (value.phase !== "retired") {
          if (value.phase !== "sessions_revoked") {
            if (!value.password) throw unavailable();
            await fresh(input, "revoke", signal);
            if (!skipLogout) {
              const signed = await ordinary.signInWithPassword({ email: value.email, password: value.password });
              if (signed.error || !signed.data.session || signed.data.user.id !== value.authUserId) throw unavailable(true);
              const logout = await auth.admin.admin.signOut(signed.data.session.access_token, "global"); if (logout.error) throw unavailable(true);
            }
            const committed = await vault.write(ref, version, { ...value, phase: "sessions_revoked" }, signal); if (committed === null) throw unavailable(true); version = committed;
          }
          await fresh(input, "revoke", signal);
          // A lost ban acknowledgement may have committed. Read the known UUID
          // before another mutation, and never infer application from HTTP 200.
          if (!accountAbsent && !hasLiveBan((await readActor())!)) {
            const banned = await auth.admin.admin.updateUserById(value.authUserId, { ban_duration: "876000h", password: randomBytes(32).toString("base64url") });
            checkUser(banned.data.user, input, value, ref); if (banned.error) throw unavailable(true);
          }
        }
        // This fresh server read also fences repeated history-cleanup attempts.
        // Global logout/ban do not cryptographically revoke an offline JWT.
        const finalActor = await readActor();
        if (accountAbsent ? finalActor !== null : !finalActor || !hasLiveBan(finalActor)) throw unavailable(true);
        if (value.phase !== "retired") {
          await fresh(input, "revoke", signal);
          const committed = await vault.write(ref, version, { ...value, phase: "retired", password: null }, signal); if (committed === null) throw unavailable(true); version = committed;
        }
        await destroyHistory(ref, version, signal);
        const retired = { version: 1, ownerId: value.ownerId, storageIdentityRef: value.storageIdentityRef, authUserId: value.authUserId, retired: true, storage: null };
        let publishedVersion = published?.version ?? 0;
        if (!published || !isDeepStrictEqual(published.data, retired)) {
          const committed = await vault.write(target, publishedVersion, retired, signal); if (committed === null) throw unavailable(true); publishedVersion = committed;
        }
        await destroyHistory(target, publishedVersion, signal);
      } catch { throw unavailable(true); }
      finally { await Promise.allSettled([ordinary?.dispose(), admin?.dispose()]); }
    },
  };
}
