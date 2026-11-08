/** Unit tests describe a local, non-hosted process. A developer shell can carry
 * unrelated VERCEL_* variables (Vercel CLI, editor and agent plugins), and the
 * app deliberately treats any of them as a hosted-runtime marker that turns
 * local development paths off. Tests that need a hosted marker stub it. */
for (const key of Object.keys(process.env)) {
  if (key === "VERCEL" || key.startsWith("VERCEL_")) delete process.env[key];
}
