import "server-only";
import { z } from "zod";
import { readDevelopmentConfiguration } from "../../src/server/development/config";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/logo-creation/openai-image-pricing";
import { createDevelopmentLogoGenerativeStorageAuthorization, qualifiedLogoGenerativeStorageCapability } from "../logo-generative-storage-authorization";
import { createDevelopmentLogoProductionStorageAuthorization, qualifiedLogoProductionStorageCapability } from "../logo-production-storage-authorization";
import { startLogoProductionHost, type LogoProductionHostOptions, type LogoProductionHost } from "../logo-production-host";
import type { LogoWorkerCapability } from "../logo-readiness";
import type { IdentityPoolPort } from "../../src/server/runtime/identity-pool";
import type { DevelopmentWorkerConfiguration, DevelopmentWorkerEnvironment } from "./config";

type Lane = "concepts" | "refinements" | "vector" | "exports";
export type DevelopmentLogoConfiguration = Readonly<{
  workerId: string; supabaseUrl: string;
  storage: Readonly<{ authUserId: string; publishableKey: string; accessToken: string }>;
  operations: Readonly<Partial<Record<Lane, LogoWorkerCapability>>>;
  image: Readonly<{ apiKey: string; model: typeof IMAGE_MODEL; rateVersion: string; paidCallsApproved: true }> | null;
}>;
const unavailable = () => new Error("development_logo_unavailable");
export class DevelopmentLogoDrainUnconfirmedError extends Error {
  readonly code = "development_logo_drain_unconfirmed";
  constructor() { super("development_logo_drain_unconfirmed"); }
}
const storageSchema = z.strictObject({ authUserId: z.uuid(),
  publishableKey: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{1,500}$/u),
  accessToken: z.string().max(16_384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u) });

/** Explicit short-lived Storage session and reviewed operation descriptors only.
 * No session discovery, login, token refresh, role/policy creation or provider I/O. */
export function readDevelopmentLogoConfiguration(env: DevelopmentWorkerEnvironment = process.env): DevelopmentLogoConfiguration | null {
  const development = readDevelopmentConfiguration(env);
  if (!development || env.EMBEL_DEVELOPMENT_DISPATCH_APPROVED !== "true") return null;
  try {
    const workerId = env.EMBEL_DEVELOPMENT_LOGO_WORKER_ID ?? "";
    if (!/^embel-dev-[A-Za-z0-9._:-]{1,170}$/u.test(workerId)) return null;
    const storage = storageSchema.parse({ authUserId: env.EMBEL_DEVELOPMENT_LOGO_STORAGE_USER_ID,
      publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, accessToken: env.EMBEL_DEVELOPMENT_LOGO_STORAGE_ACCESS_TOKEN });
    if (storage.authUserId === env.EMBEL_DEVELOPMENT_WORKER_OWNER_ID) return null;
    const serialized = env.EMBEL_DEVELOPMENT_LOGO_OPERATIONS ?? "";
    if (!serialized || Buffer.byteLength(serialized) > 16_384) return null;
    const selected = z.strictObject({ concepts: z.unknown().optional(), refinements: z.unknown().optional(),
      vector: z.unknown().optional(), exports: z.unknown().optional() }).parse(JSON.parse(serialized));
    const operations: Partial<Record<Lane, LogoWorkerCapability>> = {};
    const expected = { concepts: "identity.logo_concept", refinements: "identity.logo_refine", vector: "identity.logo_vectorize", exports: "identity.logo_export" } as const;
    for (const lane of Object.keys(expected) as Lane[]) {
      if (selected[lane] === undefined) continue;
      const capability = (lane === "concepts" || lane === "refinements" ? qualifiedLogoGenerativeStorageCapability : qualifiedLogoProductionStorageCapability)(selected[lane]);
      if (!capability || capability.operation !== expected[lane]) return null;
      operations[lane] = capability;
    }
    if (!Object.keys(operations).length) return null;
    let image: DevelopmentLogoConfiguration["image"] = null;
    if (operations.concepts || operations.refinements) {
      const apiKey = env.EMBEL_DEVELOPMENT_PROVIDER_API_KEY ?? "";
      if (env.FLUID_PAID_CALLS_APPROVED !== "true" || !/^\S{16,500}$/u.test(apiKey)
        || env.EMBEL_DEVELOPMENT_MODEL !== IMAGE_MODEL
        || !(env.EMBEL_DEVELOPMENT_VERIFIED_MODELS ?? "").split(",").map(value => value.trim()).includes(IMAGE_MODEL)
        || env.EMBEL_DEVELOPMENT_IMAGE_RATE_VERSION !== SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion) return null;
      image = Object.freeze({ apiKey, model: IMAGE_MODEL, rateVersion: SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion, paidCallsApproved: true });
    }
    return Object.freeze({ workerId, supabaseUrl: development.supabaseUrl,
      storage: Object.freeze(storage), operations: Object.freeze(operations), image });
  } catch { return null; }
}

export type DevelopmentLogoDependencies = { startHost(options: LogoProductionHostOptions): Promise<LogoProductionHost> };
/** The real host keeps per-client SQL identity, readiness, lease, per-job Auth /
 * grant rechecks and immutable bytes. It receives no production identity flags. */
export async function runDevelopmentLogo(options: {
  configuration: DevelopmentWorkerConfiguration; logo: DevelopmentLogoConfiguration;
  roleOid: number; pool: IdentityPoolPort; signal: AbortSignal;
}, dependencies: DevelopmentLogoDependencies = { startHost: startLogoProductionHost }): Promise<void> {
  const { configuration: config, logo, signal } = options;
  if (config.lane !== "logo" || config.role !== "embel_development_logo_worker"
    || !Number.isSafeInteger(options.roleOid) || options.roleOid < 1
    || readDevelopmentConfiguration()?.supabaseUrl !== logo.supabaseUrl || signal.aborted) throw unavailable();
  const authorizations: { close(): void }[] = [];
  let host: LogoProductionHost | undefined, hostInvoked = false;
  try {
    const selected: Pick<Extract<LogoProductionHostOptions, { enabled: true }>, Lane> = {};
    const common = { ownerId: config.ownerId, workerRoleName: config.role, workerRoleOid: options.roleOid,
      workerId: logo.workerId, ...logo.storage };
    for (const lane of ["concepts", "refinements"] as const) {
      const capability = logo.operations[lane]; if (!capability) continue;
      const authorization = createDevelopmentLogoGenerativeStorageAuthorization({ ...common, capability });
      if (!authorization || !logo.image) throw unavailable();
      authorizations.push(authorization); selected[lane] = { capability, authorization, image: logo.image };
    }
    for (const lane of ["vector", "exports"] as const) {
      const capability = logo.operations[lane]; if (!capability) continue;
      const authorization = createDevelopmentLogoProductionStorageAuthorization({ ...common, capability });
      if (!authorization) throw unavailable();
      authorizations.push(authorization); selected[lane] = { capability, authorization };
    }
    hostInvoked = true;
    host = await dependencies.startHost({ enabled: true, development: true,
      binding: { ownerId: config.ownerId, roleName: config.role, roleOid: options.roleOid },
      workerId: logo.workerId, pool: options.pool, signal, ...selected });
    if (host.status !== "qualified" || signal.aborted) throw unavailable();
    await host.run(signal);
  } finally {
    // Storage capabilities remain alive until the real host proves its drain.
    // A rejected close deliberately does not dispose those authorizations.
    if (hostInvoked && !host) throw new DevelopmentLogoDrainUnconfirmedError();
    try { await host?.close(); } catch { throw new DevelopmentLogoDrainUnconfirmedError(); }
    for (const authorization of authorizations) authorization.close();
  }
}
