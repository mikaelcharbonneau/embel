import "server-only";
import { z } from "zod";

const credential = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
export type StandaloneProviderConfig = {
  rdap: boolean;
  cloudflare: { accountId: string; token: string } | null;
  youtube: { apiKey: string } | null;
  euipo: { clientId: string; clientSecret: string } | null;
};
/** Dedicated opt-ins prevent accidentally reusing unrelated provider credentials. */
export function standaloneProviderConfig(env: Readonly<Record<string, string | undefined>> = process.env): StandaloneProviderConfig {
  const cloudflare = z.object({ accountId: z.string().regex(/^[a-fA-F0-9]{32}$/), token: credential }).safeParse({ accountId: env.FLUID_CLOUDFLARE_ACCOUNT_ID, token: env.FLUID_CLOUDFLARE_API_TOKEN });
  const youtube = z.object({ apiKey: credential }).safeParse({ apiKey: env.FLUID_YOUTUBE_API_KEY });
  const euipo = z.object({ clientId: credential, clientSecret: credential }).safeParse({ clientId: env.FLUID_EUIPO_CLIENT_ID, clientSecret: env.FLUID_EUIPO_CLIENT_SECRET });
  return { rdap: env.FLUID_RDAP_CHECKS_ENABLED !== "false",
    cloudflare: env.FLUID_CLOUDFLARE_CHECKS_ENABLED === "true" && cloudflare.success ? cloudflare.data : null,
    youtube: env.FLUID_YOUTUBE_CHECKS_ENABLED === "true" && youtube.success ? youtube.data : null,
    euipo: env.FLUID_EUIPO_CHECKS_ENABLED === "true" && euipo.success ? euipo.data : null };
}
