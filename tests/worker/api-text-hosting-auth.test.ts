import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyCron, verifyPublisher } from "../../worker/hosting/auth";

const configuration = { issuer: "https://oidc.vercel.com/fixture-team", audience: "https://vercel.com/fixture-team" };
const claims = { owner_id: "team_f2xtDdokmMW21ByVgpJzIDDV", project_id: "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt", environment: "preview" };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test" }] });
});
async function token(overrides = {}, issuer = configuration.issuer, expiry = "2h") {
  return new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer).setAudience(configuration.audience).setIssuedAt().setExpirationTime(expiry).sign(keys.privateKey);
}
describe("worker workload authentication", () => {
  it("accepts only signed approved web Preview workload claims", async () => {
    await expect(verifyPublisher(`Bearer ${await token()}`, configuration, jwks)).resolves.toBeUndefined();
  });
  it.each([{ owner_id: "other-team" }, { project_id: "other-project" }, { environment: "production" }, { environment: "development" }])("rejects wrong workload %o", async claims => {
    await expect(verifyPublisher(`Bearer ${await token(claims)}`, configuration, jwks)).rejects.toThrow();
  });
  it("rejects wrong issuer, expired and unsigned tokens", async () => {
    await expect(verifyPublisher(`Bearer ${await token({}, "https://oidc.vercel.com/other")}`, configuration, jwks)).rejects.toThrow();
    await expect(verifyPublisher(`Bearer ${await token({}, configuration.issuer, "-1s")}`, configuration, jwks)).rejects.toThrow();
    await expect(verifyPublisher("Bearer eyJhbGciOiJub25lIn0.e30.", configuration, jwks)).rejects.toThrow();
    await expect(verifyPublisher(null, configuration, jwks)).rejects.toThrow();
  });
  it("requires a configured bounded exact Cron bearer secret, never a user-agent/header assertion", () => {
    const secret = "x".repeat(40);
    expect(verifyCron(`Bearer ${secret}`, secret)).toBe(true);
    for (const header of [null, "vercel-cron/1.0", `Bearer ${secret}x`, "Bearer undefined", "Bearer short"]) expect(verifyCron(header, secret)).toBe(false);
    expect(verifyCron("Bearer short", "short")).toBe(false);
    expect(verifyCron("Bearer undefined", undefined)).toBe(false);
  });
});
