import { readFileSync } from "node:fs";
import { getVercelPreviewOrigin, getVercelProductionOrigin } from "../src/server/preview-origin.mjs";

try {
  // Each Vercel environment has one database: production builds must use the production
  // project and previews the staging project (scripts/deployment-targets.json), so a preview
  // can never read or write production data. Only the two explicit public inputs are
  // inspected; environment values are never enumerated or printed, including on failure.
  const targets = JSON.parse(readFileSync(new URL("./deployment-targets.json", import.meta.url), "utf8"));
  const target = targets[process.env.VERCEL_ENV === "production" ? "production" : "preview"];
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) {
    const expected = target?.[name];
    if (typeof expected !== "string" || expected.length === 0 || process.env[name] !== expected) {
      throw new Error(`Missing or mismatched public configuration: ${name}.`);
    }
  }
  if (
    targets.preview?.NEXT_PUBLIC_SUPABASE_URL === targets.production?.NEXT_PUBLIC_SUPABASE_URL ||
    targets.preview?.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY === targets.production?.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ) {
    throw new Error("Missing or mismatched public configuration: NEXT_PUBLIC_SUPABASE_URL.");
  }
  const validateOrigin = process.env.VERCEL_ENV === "production" ? getVercelProductionOrigin : getVercelPreviewOrigin;
  validateOrigin({
    APP_ORIGIN: process.env.APP_ORIGIN,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  });
  console.log("Embel deployment preflight passed.");
} catch (error) {
  // Known failures carry only fixed labels; parsing/I/O errors must not leak paths
  // or file contents. Invalid configuration always exits before the Next build.
  const reason =
    error instanceof Error &&
    /^(Missing or mismatched public configuration: [A-Z_]+\.|Invalid (preview platform context|immutable preview hostname|production platform context|production application origin)\.)$/.test(
      error.message,
    )
      ? error.message
      : "Candidate configuration is unavailable or invalid.";
  console.error(`Embel deployment preflight failed: ${reason}`);
  process.exitCode = 1;
}
