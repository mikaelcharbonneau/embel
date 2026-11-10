import { z } from "zod";
import { APPROVED_LIVE_PROJECT_REF } from "./approved-target";

type Environment = Readonly<Record<string, string | undefined>>;
const fixtureSchema = z.object({ projectId: z.uuid(), versionId: z.uuid() });
const tokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** No client creation, network access, disk access, or credential values in errors. */
export function readLiveConfig(env: Environment, approvedProjectRef = APPROVED_LIVE_PROJECT_REF) {
  if (!env.FLUID_RUN_LIVE_TESTS || env.FLUID_RUN_LIVE_TESTS === "0") return null;
  if (env.FLUID_RUN_LIVE_TESTS !== "1") throw new Error("FLUID_RUN_LIVE_TESTS must be 1 or unset.");
  if (!approvedProjectRef || !/^[a-z0-9]{20}$/.test(approvedProjectRef)) {
    throw new Error("Live tests are locked until the new Embel development project is verified.");
  }
  if (env.FLUID_LIVE_PROJECT_REF !== approvedProjectRef) {
    throw new Error("Live test target does not match the approved development project.");
  }
  const publishableKey = env.FLUID_LIVE_PUBLISHABLE_KEY ?? "";
  if (!/^sb_publishable_[A-Za-z0-9_-]{8,256}$/.test(publishableKey)) {
    throw new Error("Live tests require a publishable key; privileged and legacy keys are not accepted.");
  }
  const users = ["A", "B"].map((label) => {
    const token = env[`FLUID_LIVE_USER_${label}_ACCESS_TOKEN`] ?? "";
    const fixture = fixtureSchema.safeParse({
      projectId: env[`FLUID_LIVE_USER_${label}_PROJECT_ID`],
      versionId: env[`FLUID_LIVE_USER_${label}_ASSET_VERSION_ID`],
    });
    if (!tokenPattern.test(token) || token.length > 16384 || !fixture.success) {
      throw new Error(`Live test identity ${label} needs a temporary access token and dedicated fixture identifiers.`);
    }
    return { token, ...fixture.data };
  });
  const [a, b] = users;
  if (!a || !b || a.token === b.token || a.projectId === b.projectId || a.versionId === b.versionId) {
    throw new Error("Live tests require two distinct test identities and fixtures.");
  }
  return { url: `https://${approvedProjectRef}.supabase.co`, publishableKey, a, b };
}
