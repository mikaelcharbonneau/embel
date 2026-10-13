import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyCron, verifyPublisher } from "../../worker/hosting/auth";

const configuration = { issuer: "https://oidc.vercel.com/embel", audience: "https://vercel.com/embel" };
const subject = (environment: string) => `owner:embel:project:fluid-platform-preview:environment:${environment}`;
const claims = { owner_id: "team_0Koie5796IDOraQkDFg6J0AF", project_id: "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt", environment: "preview", sub: subject("preview") };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test" }] });
});
async function token(overrides = {}, issuer = configuration.issuer, expiry = "2h", audience: string | string[] = configuration.audience) {
  return new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expiry).sign(keys.privateKey);
}
describe("worker workload authentication", () => {
  it.each(["preview", "production"])("accepts signed approved Embel web %s workload claims", async environment => {
    await expect(verifyPublisher(`Bearer ${await token({ environment, sub: subject(environment) })}`, configuration, jwks)).resolves.toBeUndefined();
  });
  it.each([
    { owner_id: "other-team" }, { owner_id: "team_f2xtDdokmMW21ByVgpJzIDDV" }, { project_id: "other-project" },
    { environment: "development", sub: subject("development") }, { environment: "staging", sub: subject("staging") },
    { environment: "production" }, { sub: "owner:other-team:project:fluid-platform-preview:environment:preview" },
    { sub: "owner:embel:project:other-project:environment:preview" }, { sub: undefined },
  ])("rejects wrong workload %o", async claims => {
    await expect(verifyPublisher(`Bearer ${await token(claims)}`, configuration, jwks)).rejects.toThrow();
  });
  it("rejects wrong issuer, wrong audience, expired and unsigned tokens", async () => {
    await expect(verifyPublisher(`Bearer ${await token({}, "https://oidc.vercel.com/other")}`, configuration, jwks)).rejects.toThrow();
    await expect(verifyPublisher(`Bearer ${await token({}, configuration.issuer, "2h", "https://vercel.com/other")}`, configuration, jwks)).rejects.toThrow();
    await expect(verifyPublisher(`Bearer ${await token({}, configuration.issuer, "2h", [configuration.audience, "https://vercel.com/other"])}`, configuration, jwks)).rejects.toThrow();
    await expect(verifyPublisher(`Bearer ${await token({}, configuration.issuer, "-1s")}`, configuration, jwks)).rejects.toThrow();
    await expect(verifyPublisher("Bearer eyJhbGciOiJub25lIn0.e30.", configuration, jwks)).rejects.toThrow();
    await expect(verifyPublisher(null, configuration, jwks)).rejects.toThrow();
  });
  it.each([
    { issuer: "https://oidc.vercel.com/other", audience: "https://vercel.com/other" },
    { issuer: "https://oidc.vercel.com/mikael-charbonneaus-projects", audience: "https://vercel.com/mikael-charbonneaus-projects" },
    { issuer: "https://oidc.vercel.com", audience: configuration.audience },
    { issuer: configuration.issuer, audience: "https://vercel.com/other" },
    { issuer: "", audience: "" },
  ])("rejects unapproved configured trust %o", async trust => {
    await expect(verifyPublisher(`Bearer ${await token({}, trust.issuer, "2h", trust.audience)}`, trust, jwks)).rejects.toThrow();
  });
  it("rejects a correctly scoped token signed by an untrusted key", async () => {
    const untrusted = await generateKeyPair("RS256");
    const forged = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(configuration.issuer).setAudience(configuration.audience).setIssuedAt().setExpirationTime("2h").sign(untrusted.privateKey);
    await expect(verifyPublisher(`Bearer ${forged}`, configuration, jwks)).rejects.toThrow();
  });
  it("requires a configured bounded exact Cron bearer secret, never a user-agent/header assertion", () => {
    const secret = "x".repeat(40);
    expect(verifyCron(`Bearer ${secret}`, secret)).toBe(true);
    for (const header of [null, "vercel-cron/1.0", `Bearer ${secret}x`, "Bearer undefined", "Bearer short"]) expect(verifyCron(header, secret)).toBe(false);
    expect(verifyCron("Bearer short", "short")).toBe(false);
    expect(verifyCron("Bearer undefined", undefined)).toBe(false);
  });
});
