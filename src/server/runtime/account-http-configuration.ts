import "server-only";
import { z } from "zod";
import { ApiError } from "@/server/http/errors";
import { getSupabaseConfiguration } from "@/server/config";
import { LOGO_SUPABASE_ORIGIN } from "./logo-web-configuration";
import { managedQualificationSchema, type ManagedQualification } from "./managed-principal";

type Environment = Readonly<Record<string, string | undefined>>;
export type AccountHttpCapability = Readonly<{
  ownerId: string; roleName: string; roleOid: number; managed?: ManagedQualification;
  database: Readonly<{ host: string; port: 5432; database: "postgres"; user: string; password: string }>;
}>;
export type AccountHttpConfiguration = Readonly<{
  owners: readonly Readonly<{ ownerId: string; identity?: AccountHttpCapability; attachments?: AccountHttpCapability }>[];
  publishableKey: string;
}>;
const projectRef = "fricsfwqibyhemknqgyf";
const directHost = `db.${projectRef}.supabase.co`;
const poolerHost = "aws-0-us-east-1.pooler.supabase.com";
const unavailable = () => new ApiError("integration_unavailable");
const legacyCapabilitySchema = z.strictObject({ roleName: z.string().min(1).max(63), roleOid: z.number().int().min(1).max(4_294_967_295), databaseUrl: z.string().min(1).max(8192) });
export const managedAccountHttpCapabilitySchema = legacyCapabilitySchema.extend(managedQualificationSchema.shape);
const capabilitySchema = z.union([legacyCapabilitySchema, managedAccountHttpCapabilitySchema]);
const ownerSchema = z.strictObject({ ownerId: z.uuid(), identity: capabilitySchema.optional(), attachments: capabilitySchema.optional() });

/** Explicit, server-only operator registry. It neither enrolls signups nor
 * discovers credentials, reads files, creates logins or changes DB authority. */
export function readAccountHttpConfiguration(env: Environment = process.env): AccountHttpConfiguration | null {
  if (env.EMBEL_ACCOUNT_HTTP_ENABLED !== "true") return null;
  try {
    const publicConfiguration = getSupabaseConfiguration(env);
    if (publicConfiguration.url !== LOGO_SUPABASE_ORIGIN ||
      !/^sb_publishable_[A-Za-z0-9_-]{1,500}$/u.test(publicConfiguration.publishableKey)) throw unavailable();
    const raw = env.EMBEL_ACCOUNT_HTTP_BINDINGS;
    if (!raw || Buffer.byteLength(raw) > 262_144) throw unavailable();
    return parseAccountHttpConfiguration(JSON.parse(raw), publicConfiguration.publishableKey);
  } catch { throw unavailable(); }
}


/** Shared strict credential parser for trusted static configuration and dynamic
 * publications. Managed bindings have an explicit version; legacy rows retain
 * their strict incoming-membership qualification. No input is ever logged. */
export function parseAccountHttpConfiguration(input: unknown, publishableKey: string): AccountHttpConfiguration {
  try {
    if (!/^sb_publishable_[A-Za-z0-9_-]{1,500}$/u.test(publishableKey)) throw unavailable();
    const parsed = z.array(ownerSchema).min(1).max(100).safeParse(input);
    if (!parsed.success) throw unavailable();
    const ownerIds = new Set<string>(), logins = new Set<string>(), oids = new Set<number>();
    function capability(ownerId: string, lane: "identity" | "attachments", input: z.infer<typeof capabilitySchema>): AccountHttpCapability {
      const expectedPrefix = lane === "identity" ? /^embel_identity_web_[a-z0-9_]+$/u : /^embel_home_web_[a-z0-9_]+$/u;
      if (!expectedPrefix.test(input.roleName) || logins.has(input.roleName) || oids.has(input.roleOid) ||
        /[\s\x00-\x1f\x7f]/u.test(input.databaseUrl)) throw unavailable();
      const url = new URL(input.databaseUrl), host = url.hostname;
      if (!["postgres:", "postgresql:"].includes(url.protocol) || ![directHost, poolerHost].includes(host) ||
        url.port !== "5432" || url.pathname !== "/postgres" || url.hash ||
        !/^postgres(?:ql)?:\/\/[^@/?#]+@(?:db\.fricsfwqibyhemknqgyf\.supabase\.co|aws-0-us-east-1\.pooler\.supabase\.com):5432\/postgres\?sslmode=verify-full$/u.test(input.databaseUrl)) throw unavailable();
      const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
      if (user !== (host === poolerHost ? `${input.roleName}.${projectRef}` : input.roleName) ||
        !password || password.length > 4096 || /[\x00-\x1f\x7f]/u.test(password)) throw unavailable();
      const managed = "managementVersion" in input ? managedQualificationSchema.parse({ managementVersion: input.managementVersion,
        generation: input.generation, revision: input.revision, operationKey: input.operationKey, capability: input.capability,
        managerRoleName: input.managerRoleName, managerRoleOid: input.managerRoleOid }) : undefined;
      if (managed && (managed.capability !== (lane === "identity" ? "identity_transactions" : "home_attachments") ||
        input.roleName !== `${lane === "identity" ? "embel_identity_web_" : "embel_home_web_"}${ownerId.replaceAll("-", "")}`)) throw unavailable();
      const database = { host, port: 5432 as const, database: "postgres" as const, user, password: "" };
      Object.defineProperty(database, "password", { value: password, enumerable: false });
      logins.add(input.roleName); oids.add(input.roleOid);
      return Object.freeze({ ownerId, roleName: input.roleName, roleOid: input.roleOid, ...(managed ? { managed: Object.freeze(managed) } : {}), database: Object.freeze(database) });
    }
    const owners = parsed.data.map(input => {
      const ownerId = input.ownerId.toLowerCase();
      if (ownerIds.has(ownerId) || !input.identity && !input.attachments) throw unavailable();
      ownerIds.add(ownerId);
      return Object.freeze({ ownerId,
        ...(input.identity ? { identity: capability(ownerId, "identity", input.identity) } : {}),
        ...(input.attachments ? { attachments: capability(ownerId, "attachments", input.attachments) } : {}),
      });
    });
    return Object.freeze({ owners: Object.freeze(owners), publishableKey });
  } catch { throw unavailable(); }
}
