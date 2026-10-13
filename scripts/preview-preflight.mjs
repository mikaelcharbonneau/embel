import { readFileSync } from 'node:fs';
import { getVercelPreviewOrigin, getVercelProductionOrigin } from '../src/server/preview-origin.mjs';

try {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  // Only inspect the two explicit public inputs. Never enumerate environment
  // values or print supplied values, including on failure.
  for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']) {
    const expected = config.env?.[name];
    if (typeof expected !== 'string' || expected.length === 0 || config.build?.env?.[name] !== expected || process.env[name] !== expected) {
      throw new Error(`Missing or mismatched public configuration: ${name}.`);
    }
  }
  const validateOrigin = process.env.VERCEL_ENV === 'production'
    ? getVercelProductionOrigin : getVercelPreviewOrigin;
  validateOrigin({
    APP_ORIGIN: process.env.APP_ORIGIN,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  });
  console.log('Embel deployment preflight passed.');
} catch (error) {
  // Known failures carry only fixed labels; parsing/I/O errors must not leak paths
  // or file contents. Invalid configuration always exits before the Next build.
  const reason = error instanceof Error && /^(Missing or mismatched public configuration: [A-Z_]+\.|Invalid (preview platform context|immutable preview hostname|production platform context|production application origin)\.)$/.test(error.message)
    ? error.message : 'Candidate configuration is unavailable or invalid.';
  console.error(`Embel deployment preflight failed: ${reason}`);
  process.exitCode = 1;
}
