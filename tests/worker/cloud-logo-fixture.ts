import { readFileSync } from "node:fs";
import { CLOUD_LOGO_BINDING, CLOUD_LOGO_POLICY_IDENTITY, CLOUD_LOGO_PROJECT_ID, CLOUD_LOGO_RUNTIME, CLOUD_LOGO_STORAGE_USER_ID,
  CLOUD_LOGO_WORKER_ID, readCloudLogoConfiguration, type CloudLogoMode } from "../../worker/cloud-logo-configuration";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/logo-creation/openai-image-pricing";
export const cloudLogoSecret = "synthetic-private-logo-cloud-value";
export const cloudLogoRevision = "a".repeat(40);
export function cloudLogoInput() {
  const concept = { operation: "identity.logo_concept", policyIdentity: CLOUD_LOGO_POLICY_IDENTITY, handlerVersion: "logo-image-v1",
    provider: "openai", model: IMAGE_MODEL, engine: null, maxCostMicrousd: 2_000_000 };
  return { version: 1, enabled: true, binding: { ...CLOUD_LOGO_BINDING }, workerId: CLOUD_LOGO_WORKER_ID,
    database: { host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, database: "postgres", password: cloudLogoSecret },
    storage: { authUserId: CLOUD_LOGO_STORAGE_USER_ID, publishableKey: "sb_publishable_synthetic", sessionApproved: true },
    image: { apiKey: cloudLogoSecret, model: IMAGE_MODEL, rateVersion: SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion, paidCallsApproved: true },
    operations: { concepts: concept, refinements: { ...concept, operation: "identity.logo_refine" } } };
}
export function cloudLogoEnv(): Record<string, string | undefined> {
  return { NODE_ENV: "production", FLUID_RUNTIME: "cloud", FLUID_LOCAL_PROTOTYPE: "false", VERCEL: "1", VERCEL_ENV: "production",
    VERCEL_TARGET_ENV: "production", VERCEL_REGION: "iad1", VERCEL_GIT_PROVIDER: "github", VERCEL_GIT_REPO_OWNER: "mikaelcharbonneau",
    VERCEL_GIT_REPO_SLUG: "embel", VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_COMMIT_SHA: cloudLogoRevision,
    VERCEL_PROJECT_ID: CLOUD_LOGO_PROJECT_ID, VERCEL_DEPLOYMENT_ID: "dpl_SyntheticCloudLogoDeployment",
    EMBEL_LOGO_CLOUD_ACTIVATED: "true", EMBEL_LOGO_WORKER_CONFIGURATION_JSON: JSON.stringify(cloudLogoInput()),
    EMBEL_LOGO_STORAGE_IDENTITY_JSON: JSON.stringify({ version: 1, ownerId: CLOUD_LOGO_BINDING.ownerId,
      authUserId: CLOUD_LOGO_STORAGE_USER_ID, email: "synthetic@example.invalid", password: cloudLogoSecret }),
    EMBEL_LOGO_DATABASE_CA_PEM: readFileSync(new URL("../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8") };
}
export function cloudLogoConfiguration(mode: CloudLogoMode = "run", env = cloudLogoEnv()) {
  return readCloudLogoConfiguration({ mode, env, sourceRevision: cloudLogoRevision, expectedProjectId: CLOUD_LOGO_PROJECT_ID,
    versions: CLOUD_LOGO_RUNTIME, platform: "linux", arch: "x64" });
}
export function cloudLogoToken() {
  const claims = { sub: CLOUD_LOGO_STORAGE_USER_ID, role: "authenticated", aud: "authenticated", iss: "https://fricsfwqibyhemknqgyf.supabase.co/auth/v1",
    session_id: "d0000000-0000-4000-8000-000000000003", is_anonymous: false, exp: Math.floor(Date.now() / 1000) + 3600 };
  return `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c3ludGhldGlj`;
}
