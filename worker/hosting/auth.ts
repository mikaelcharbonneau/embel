import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const keys = createRemoteJWKSet(new URL("https://oidc.vercel.com/.well-known/jwks"), { timeoutDuration: 3_000 });
export const APPROVED_WEB_PROJECT = "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt";
export const APPROVED_TEAM = "team_f2xtDdokmMW21ByVgpJzIDDV";
export type PublisherTrust = { issuer: string; audience: string };

/** Verify signature and exact workload claims, independently of edge protection. */
export async function verifyPublisher(authorization: string | null, configuration: PublisherTrust, jwks: JWTVerifyGetKey = keys): Promise<void> {
  if (!authorization?.startsWith("Bearer ") || authorization.length > 16_384) throw new Error("Unauthorized");
  if (!/^https:\/\/oidc\.vercel\.com(?:\/[A-Za-z0-9_-]+)?$/.test(configuration.issuer) || !/^https:\/\/vercel\.com\/[A-Za-z0-9_-]+$/.test(configuration.audience)) throw new Error("Unconfigured publisher trust");
  const { payload } = await jwtVerify(authorization.slice(7), jwks, {
    issuer: configuration.issuer, audience: configuration.audience, algorithms: ["RS256"],
    requiredClaims: ["iat", "exp", "owner_id", "project_id", "environment"], maxTokenAge: "2h",
  });
  if (payload.owner_id !== APPROVED_TEAM || payload.project_id !== APPROVED_WEB_PROJECT || payload.environment !== "preview") throw new Error("Unauthorized");
}
export function verifyCron(authorization: string | null, secret: string | undefined): boolean {
  return cronAuthFailure(authorization, secret) === null;
}
export type CronAuthFailure = "secret_missing" | "secret_invalid" | "authorization_missing" | "authorization_oversized" | "authorization_mismatch";
/** Static labels only: never return input values or derived secret/header metadata. */
export function cronAuthFailure(authorization: string | null, secret: string | undefined): CronAuthFailure | null {
  if (!secret) return "secret_missing";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) return "secret_invalid";
  if (!authorization) return "authorization_missing";
  if (authorization.length > 300) return "authorization_oversized";
  const expected = Buffer.from(`Bearer ${secret}`); const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? null : "authorization_mismatch";
}
