import "server-only";

/** The official OpenAI API origin. Production always uses exactly this. */
export const OPENAI_ORIGIN = "https://api.openai.com";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The origin the generation engine sends OpenAI requests to.
 *
 * `EMBEL_OPENAI_BASE_URL` points the engine at a local stand-in provider for the
 * browser journey test (tests/journey). It is read on the server only and:
 * - is ignored in production (`VERCEL_ENV=production`): production can never be redirected;
 * - elsewhere must be a plain loopback origin (`http://127.0.0.1:PORT`, no path, query or
 *   login), so the API key can only ever travel to this machine. Anything else is refused.
 */
export function engineOpenAIOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env.EMBEL_OPENAI_BASE_URL;
  if (env.VERCEL_ENV === "production" || override === undefined || override === "") return OPENAI_ORIGIN;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error("provider_unconfigured");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !LOOPBACK.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    override.replace(/\/$/u, "") !== url.origin
  )
    throw new Error("provider_unconfigured");
  return url.origin;
}
