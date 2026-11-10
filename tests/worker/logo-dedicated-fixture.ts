import { CAPPED_LOGO_IMAGE_MODEL } from "../../src/domain/providers";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/ai/openai-image-pricing";
import { LOGO_IMAGE_HANDLER_VERSION } from "../../src/server/ai/logo-image-prompts";
import { LOGO_EXPORT_HANDLER_VERSION, LOGO_EXPORT_POLICY_IDENTITY } from "../../worker/handlers/logo-exports";
import { QUALIFIED_VTRACER } from "../../src/server/image-process/engine";
export const syntheticSecret = "synthetic-private-value-never-display";
export const identity = { ownerId: "d0000000-0000-4000-8000-000000000001", roleName: "fluid_logo_worker_launcher_fixture", roleOid: 1234 };
export const authUserId = "d0000000-0000-4000-8000-000000000002";
export const claims = () => ({ sub: authUserId, role: "authenticated", aud: "authenticated", iss: "https://fricsfwqibyhemknqgyf.supabase.co/auth/v1",
  session_id: "d0000000-0000-4000-8000-000000000003", is_anonymous: false, exp: Math.floor(Date.now() / 1000) + 3600 });
export const token = (body: Record<string, unknown> = claims()) => `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.c3ludGhldGlj`;
export const imageCapability = (operation: "identity.logo_concept" | "identity.logo_refine" = "identity.logo_concept") => ({ operation,
  policyIdentity: "c".repeat(64), handlerVersion: LOGO_IMAGE_HANDLER_VERSION, provider: "openai", model: CAPPED_LOGO_IMAGE_MODEL, engine: null, maxCostMicrousd: 2000 });
export const vectorCapability = () => ({ operation: "identity.logo_vectorize", policyIdentity: "b".repeat(64), handlerVersion: "1", provider: null, model: null,
  engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm }, maxCostMicrousd: 0 });
export const exportCapability = () => ({ operation: "identity.logo_export", policyIdentity: LOGO_EXPORT_POLICY_IDENTITY,
  handlerVersion: LOGO_EXPORT_HANDLER_VERSION, provider: null, model: null, engine: null, maxCostMicrousd: 0 });
export const configurationInput = () => ({ version: 1, enabled: true, binding: { ...identity }, workerId: "synthetic-logo-dedicated",
  database: { host: "db.fricsfwqibyhemknqgyf.supabase.co", port: 5432, database: "postgres", password: syntheticSecret },
  storage: { authUserId, publishableKey: "sb_publishable_synthetic", accessToken: token(), sessionApproved: true },
  image: { apiKey: syntheticSecret, model: CAPPED_LOGO_IMAGE_MODEL, rateVersion: SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion, paidCallsApproved: true },
  operations: { concepts: imageCapability(), refinements: imageCapability("identity.logo_refine"), vector: vectorCapability(), exports: exportCapability() },
});
