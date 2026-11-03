// Vitest setup: the ordinary suite must see the same ambient environment on a
// developer machine as on CI's clean runners. Hosted-runtime guards treat any
// VERCEL / VERCEL_* key as a hosted execution marker, so an unrelated variable
// exported by a developer tool (for example a Vercel editor plugin) would
// otherwise make local-only code paths refuse to start. Tests that need these
// markers stub them explicitly with vi.stubEnv or a literal env object.
for (const key of Object.keys(process.env)) {
  if (/^VERCEL(?:_|$)/u.test(key)) delete process.env[key];
}
