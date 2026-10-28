import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthenticatedContext } from "@/server/auth/context";
import { getSupabaseConfiguration } from "@/server/config";
import { ApiError } from "@/server/http/errors";
import { createVaultAccountHttpBindingSource } from "../../../worker/account-enrollment/http-publication";
import { LOGO_SUPABASE_ORIGIN } from "./logo-web-configuration";
import { managedAccountHttpCapabilitySchema, parseAccountHttpConfiguration, type AccountHttpConfiguration } from "./account-http-configuration";
import { sharedAccountHttpConfigured, acquireSharedAccountIdentity, acquireSharedAccountHome } from "../shared-account/bootstrap";
import { createAccountHttpRuntimeFromConfiguration, resolveAccountHomeAttachmentService, resolveAccountIdentityRuntime,
  type AccountHomeAttachmentService, type AccountHttpRuntime, type AccountIdentityRuntime } from "./account-http-services";

type Environment = Readonly<Record<string, string | undefined>>;
type Lane = "identity" | "attachments";
export interface AccountHttpBindingSource { read(ownerId: string, signal?: AbortSignal): Promise<unknown> }
export type AccountHttpRuntimeLease<T> = Readonly<{ configured: boolean; value: T | null; release(): Promise<void> }>;
const unavailable = () => new ApiError("integration_unavailable");
const receipt = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
const authorityLane = z.strictObject({ operationKey: z.uuid(), publicationReceipt: receipt.nullable(), ready: z.boolean() })
  .refine(value => !value.ready || value.publicationReceipt !== null);
const authoritySchema = z.strictObject({ ownerId: z.uuid(), generation: z.number().int().positive(), revision: z.number().int().positive(),
  identity: authorityLane.nullable(), attachments: authorityLane.nullable() });
const publishedLane = z.strictObject({ publicationReceipt: receipt, configuration: managedAccountHttpCapabilitySchema });
const publishedSchema = z.strictObject({ ownerId: z.uuid(), generation: z.number().int().positive(), revision: z.number().int().positive(),
  identity: publishedLane.optional(), attachments: publishedLane.optional() });
type Authority = z.infer<typeof authoritySchema>;
const noRelease = async () => {};
function empty<T>(configured = true): AccountHttpRuntimeLease<T> { return { configured, value: null, release: noRelease }; }
function active(signal: AbortSignal) { if (signal.aborted) throw unavailable(); }
async function interruptible<T>(signal: AbortSignal, action: () => PromiseLike<T>): Promise<T> {
  active(signal);
  let rejectAborted!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const stop = () => rejectAborted(unavailable()); signal.addEventListener("abort", stop, { once: true });
  try { return await Promise.race([Promise.resolve().then(() => { active(signal); return action(); }), aborted]); }
  finally { signal.removeEventListener("abort", stop); }
}
async function authority(auth: AuthenticatedContext, signal: AbortSignal): Promise<Authority> {
  active(signal);
  const result = await interruptible(signal, () => {
    // No owner, generation, capability or privileged credential is accepted by
    // this RPC. SQL derives a confirmed current account from the verified JWT.
    const query = auth.client.rpc("get_account_service_enrollment_binding");
    return typeof query.abortSignal === "function" ? query.abortSignal(signal) : query;
  });
  active(signal);
  const parsed = authoritySchema.safeParse(result.data);
  if (result.error || !parsed.success || parsed.data.ownerId !== auth.userId.toLowerCase()) throw unavailable();
  return parsed.data;
}
function configurationFor(value: unknown, expected: Authority, lane: Lane, publishableKey: string): AccountHttpConfiguration {
  const parsed = publishedSchema.safeParse(value);
  if (!parsed.success || parsed.data.ownerId !== expected.ownerId || parsed.data.generation !== expected.generation ||
    parsed.data.revision !== expected.revision || !expected[lane]?.ready || !parsed.data[lane]) throw unavailable();
  const record = parsed.data;
  const owner: { ownerId: string; identity?: unknown; attachments?: unknown } = { ownerId: record.ownerId };
  for (const name of ["identity", "attachments"] as const) {
    const publication = record[name]; if (!publication) continue;
    const proof = expected[name], input = publication.configuration;
    if (!proof || input.generation !== expected.generation || input.revision !== expected.revision ||
      input.operationKey !== proof.operationKey || publication.publicationReceipt !== proof.publicationReceipt ||
      input.capability !== (name === "identity" ? "identity_transactions" : "home_attachments")) throw unavailable();
    if (proof.ready) owner[name] = input;
  }
  return parseAccountHttpConfiguration([owner], publishableKey);
}
function sameAuthority(a: Authority, b: Authority, configuration: AccountHttpConfiguration) {
  if (a.ownerId !== b.ownerId || a.generation !== b.generation || a.revision !== b.revision) throw unavailable();
  for (const lane of ["identity", "attachments"] as const) if (configuration.owners[0]![lane]) {
    const previous = a[lane], current = b[lane];
    if (!previous?.ready || !current?.ready || current.operationKey !== previous.operationKey ||
      current.publicationReceipt !== previous.publicationReceipt) throw unavailable();
  }
}
function fingerprint(configuration: AccountHttpConfiguration, authority: Authority) {
  const owner = configuration.owners[0]!;
  return createHash("sha256").update(JSON.stringify({ ownerId: owner.ownerId, publication: { identity: authority.identity, attachments: authority.attachments }, lanes: ["identity", "attachments"].map(lane => {
    const capability = owner[lane as Lane]; if (!capability) return null;
    return { roleName: capability.roleName, roleOid: capability.roleOid, managed: capability.managed,
      database: { ...capability.database, password: capability.database.password } };
  }) })).digest("hex");
}
type Entry = { ownerId: string; key: string; roleOids: number[]; runtime: AccountHttpRuntime; references: number;
  used: number; retired: boolean; closing?: Promise<void>; idle: (() => void)[] };

/** A bounded pool cache, not an enrollment registry. Every request repeats Auth
 * authority, publication lookup and actual-session qualification. Entries retain
 * only prepared restricted pools; no Auth context/token/checked-out connection,
 * service instance carrying a token, or readiness result enters this cache. */
export function createAccountHttpBindingSourceRuntime(dependencies: { source: AccountHttpBindingSource; publishableKey: string;
  createRuntime?: (configuration: AccountHttpConfiguration) => AccountHttpRuntime; capacity?: number }) {
  const capacity = z.number().int().min(1).max(100).parse(dependencies.capacity ?? 100);
  const entries = new Map<string, Entry>(); let clock = 0, closed = false;
  let mutation = Promise.resolve();
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = mutation.then(action); mutation = result.then(() => {}, () => {}); return result;
  }
  async function closeEntry(entry: Entry) {
    if (entries.get(entry.key) !== entry) return;
    if (entry.references !== 0) throw unavailable();
    entry.retired = true;
    await (entry.closing ??= entry.runtime.close());
    entries.delete(entry.key);
  }
  async function release(entry: Entry) {
    entry.references--; entry.used = ++clock;
    if (entry.references === 0) {
      for (const resolve of entry.idle.splice(0)) resolve();
      if (entry.retired) await serialized(() => closeEntry(entry));
    }
  }
  async function retireOwner(ownerId: string) {
    await serialized(async () => {
      for (const entry of [...entries.values()]) if (entry.ownerId === ownerId.toLowerCase()) {
        entry.retired = true;
        if (entry.references === 0) await closeEntry(entry);
      }
    });
  }
  async function obtain(configuration: AccountHttpConfiguration, authority: Authority, signal: AbortSignal) {
    return serialized(async () => {
      active(signal); if (closed) throw unavailable();
      const owner = configuration.owners[0]!, key = fingerprint(configuration, authority);
      const cached = entries.get(key);
      if (cached) {
        if (cached.retired || cached.closing) throw unavailable();
        cached.references++; cached.used = ++clock; return cached;
      }
      const roleOids = [owner.identity?.roleOid, owner.attachments?.roleOid].filter((oid): oid is number => oid !== undefined);
      for (const entry of entries.values()) {
        if (entry.ownerId !== owner.ownerId && entry.roleOids.some(oid => roleOids.includes(oid))) throw unavailable();
        if (entry.ownerId === owner.ownerId) {
          entry.retired = true; if (entry.references === 0) await closeEntry(entry);
        }
      }
      if (entries.size >= capacity) {
        const idle = [...entries.values()].filter(entry => entry.references === 0 && !entry.closing).sort((a, b) => a.used - b.used)[0];
        if (!idle) throw unavailable(); await closeEntry(idle);
      }
      active(signal);
      const runtime = (dependencies.createRuntime ?? createAccountHttpRuntimeFromConfiguration)(configuration);
      const entry: Entry = { ownerId: owner.ownerId, key, roleOids, runtime, references: 1, used: ++clock, retired: false, idle: [] };
      entries.set(key, entry); return entry;
    });
  }
  async function acquire<T>(auth: AuthenticatedContext, lane: Lane, resolve: (runtime: AccountHttpRuntime, signal: AbortSignal) => Promise<T | null>, requestedSignal?: AbortSignal): Promise<AccountHttpRuntimeLease<T>> {
    let entry: Entry | undefined;
    const signal = requestedSignal ? AbortSignal.any([requestedSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    try {
      if (closed || !z.uuid().safeParse(auth.userId).success) return empty();
      const expected = await authority(auth, signal);
      if (!expected[lane]?.ready) { await retireOwner(auth.userId); return empty(); }
      // First obtain owner-derived authority. Foreign, unknown, banned and
      // pending owners never reach the external credential source.
      const value = await interruptible(signal, () => dependencies.source.read(expected.ownerId, signal));
      const configuration = configurationFor(value, expected, lane, dependencies.publishableKey);
      // Publication lookup can be slow. Re-check generation and receipt before
      // pool construction/checkout and before selecting any Storage token.
      sameAuthority(expected, await authority(auth, signal), configuration);
      entry = await obtain(configuration, expected, signal);
      const result = await resolve(entry.runtime, signal);
      active(signal);
      if (result === null) { await retireOwner(auth.userId); const failed = entry; entry = undefined; await release(failed); return empty(); }
      let released = false;
      const leased = entry; entry = undefined;
      return { configured: true, value: result, async release() { if (released) return; released = true; await release(leased); } };
    } catch {
      // Rejected Auth/publication evidence also withdraws previously cached
      // pools. Idle connections can drain immediately; existing request leases
      // finish normally and close the retired pool on their final release.
      if (z.uuid().safeParse(auth.userId).success) { try { await retireOwner(auth.userId); } catch {} }
      if (entry) { try { await release(entry); } catch {} }
      return empty();
    }
  }
  return {
    acquireIdentity(auth: AuthenticatedContext, signal?: AbortSignal) {
      return acquire(auth, "identity", (runtime, deadline) => runtime.resolveIdentity(auth.userId, deadline), signal);
    },
    acquireHome(auth: AuthenticatedContext, signal?: AbortSignal) {
      return acquire(auth, "attachments", (runtime, deadline) => runtime.resolveHome(auth, deadline), signal);
    },
    async close() {
      closed = true;
      const pending = await serialized(async () => [...entries.values()].map(entry => {
        entry.retired = true;
        return entry.references === 0 ? Promise.resolve() : new Promise<void>(resolve => entry.idle.push(resolve));
      }));
      await Promise.all(pending);
      await serialized(async () => { for (const entry of [...entries.values()]) await closeEntry(entry); });
    },
  };
}

type SourceRuntime = ReturnType<typeof createAccountHttpBindingSourceRuntime>;
const sourceSlot = Symbol.for("embel.account-http.binding-source.v1");
type SourceState = { configured: boolean; runtime?: SourceRuntime; status: "disabled" | "installed" | "unavailable" };
const sourceConfigurationSchema = z.strictObject({ vault: z.unknown(), publicationPrefix: z.string(), credentialPrefix: z.string() });
/** Optional server-only process injection. Construction does not contact Vault,
 * grant access, install SQL, or claim any enrolled account is ready. */
export function startAccountHttpBindingSource(env: Environment, dependencies: {
  createSource?: (configuration: z.infer<typeof sourceConfigurationSchema>) => AccountHttpBindingSource;
  createRuntime?: (configuration: AccountHttpConfiguration) => AccountHttpRuntime;
} = {}) {
  const previous = Reflect.get(globalThis, sourceSlot) as SourceState | undefined;
  if (previous) return previous.status;
  const state: SourceState = { configured: env.EMBEL_ACCOUNT_HTTP_SOURCE_ENABLED === "true", status: "disabled" };
  Object.defineProperty(globalThis, sourceSlot, { value: state, configurable: true });
  if (!state.configured) return state.status;
  state.status = "unavailable";
  try {
    const publicConfiguration = getSupabaseConfiguration(env);
    if (publicConfiguration.url !== LOGO_SUPABASE_ORIGIN || !/^sb_publishable_[A-Za-z0-9_-]{1,500}$/u.test(publicConfiguration.publishableKey)) throw unavailable();
    const raw = env.EMBEL_ACCOUNT_HTTP_SOURCE_CONFIG;
    if (!raw || Buffer.byteLength(raw) > 16_384) throw unavailable();
    const configuration = sourceConfigurationSchema.parse(JSON.parse(raw));
    state.runtime = createAccountHttpBindingSourceRuntime({ source: (dependencies.createSource ?? createVaultAccountHttpBindingSource)(configuration),
      publishableKey: publicConfiguration.publishableKey, createRuntime: dependencies.createRuntime });
    state.status = "installed";
  } catch { /* Configuration and credential-bearing errors never leave startup. */ }
  return state.status;
}
function configuredSource(): SourceState | undefined {
  const state = Reflect.get(globalThis, sourceSlot) as SourceState | undefined;
  return state?.configured ? state : process.env.EMBEL_ACCOUNT_HTTP_SOURCE_ENABLED === "true" ? { configured: true, status: "unavailable" } : undefined;
}
export async function acquireAccountIdentityRuntime(auth: AuthenticatedContext, signal?: AbortSignal): Promise<AccountHttpRuntimeLease<AccountIdentityRuntime>> {
  if (sharedAccountHttpConfigured()) return acquireSharedAccountIdentity(auth, signal);
  const source = configuredSource();
  if (source) return source.runtime ? source.runtime.acquireIdentity(auth, signal) : empty();
  return { configured: false, value: await resolveAccountIdentityRuntime(auth.userId, signal), release: noRelease };
}
export async function acquireAccountHomeAttachmentService(auth: AuthenticatedContext, signal?: AbortSignal): Promise<AccountHttpRuntimeLease<AccountHomeAttachmentService>> {
  if (sharedAccountHttpConfigured()) return acquireSharedAccountHome(auth, signal);
  const source = configuredSource();
  if (source) return source.runtime ? source.runtime.acquireHome(auth, signal) : empty();
  return { configured: false, value: await resolveAccountHomeAttachmentService(auth, signal), release: noRelease };
}
