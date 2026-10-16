import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const APPROVED_ISSUER = "https://oidc.vercel.com/embel";
const APPROVED_AUDIENCE = "https://vercel.com/embel";
const keys = createRemoteJWKSet(new URL(`${APPROVED_ISSUER}/.well-known/jwks`), { timeoutDuration: 3_000 });
export const APPROVED_WEB_PROJECT = "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt";
export const APPROVED_TEAM = "team_0Koie5796IDOraQkDFg6J0AF";
export type PublisherTrust = { issuer: string; audience: string; allowLocalDevelopment?: boolean };

/** Verify signature and exact workload claims, independently of edge protection. */
export async function verifyPublisher(authorization: string | null, configuration: PublisherTrust, jwks: JWTVerifyGetKey = keys): Promise<void> {
  if (!authorization?.startsWith("Bearer ") || authorization.length > 16_384) throw new Error("Unauthorized");
  if (configuration.issuer !== APPROVED_ISSUER || configuration.audience !== APPROVED_AUDIENCE) throw new Error("Unconfigured publisher trust");
  const { payload } = await jwtVerify(authorization.slice(7), jwks, {
    issuer: configuration.issuer, audience: configuration.audience, algorithms: ["RS256"],
    requiredClaims: ["iat", "exp", "sub", "owner_id", "project_id", "environment"], maxTokenAge: "2h",
  });
  const approvedEnvironment = payload.environment === "preview" || payload.environment === "production" ||
    (configuration.allowLocalDevelopment === true && payload.environment === "development");
  if (payload.owner_id !== APPROVED_TEAM || payload.project_id !== APPROVED_WEB_PROJECT || payload.aud !== APPROVED_AUDIENCE ||
      !approvedEnvironment ||
      // Allow only the existing and renamed subject for the same immutable web project.
      (payload.sub !== `owner:embel:project:fluid-platform-preview:environment:${payload.environment}` &&
       payload.sub !== `owner:embel:project:embel:environment:${payload.environment}`)) throw new Error("Unauthorized");
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
