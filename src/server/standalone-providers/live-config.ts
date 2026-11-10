import "server-only";
import { z } from "zod";

const credential = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
export const namecomConfigSchema = z.strictObject({
  username: credential.refine((value) => !value.includes(":"), "Invalid API username"),
  token: credential,
  environment: z.enum(["production", "sandbox"]),
});
export type NamecomConfig = z.infer<typeof namecomConfigSchema>;
export type StandaloneProviderConfig = {
  namecom: NamecomConfig | null;
  rdap: boolean;
  vercel: boolean;
  cloudflare: { accountId: string; token: string } | null;
  youtube: { apiKey: string } | null;
  euipo: { clientId: string; clientSecret: string } | null;
};
/** Public domain reads have explicit opt-outs; credentialed providers require dedicated opt-ins. */
export function standaloneProviderConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StandaloneProviderConfig {
  const namecom = namecomConfigSchema.safeParse({
    username: env.FLUID_NAMECOM_USERNAME,
    token: env.FLUID_NAMECOM_API_TOKEN,
    environment: env.FLUID_NAMECOM_ENVIRONMENT ?? "production",
  });
  const cloudflare = z
    .object({ accountId: z.string().regex(/^[a-fA-F0-9]{32}$/), token: credential })
    .safeParse({ accountId: env.FLUID_CLOUDFLARE_ACCOUNT_ID, token: env.FLUID_CLOUDFLARE_API_TOKEN });
  const youtube = z.object({ apiKey: credential }).safeParse({ apiKey: env.FLUID_YOUTUBE_API_KEY });
  const euipo = z
    .object({ clientId: credential, clientSecret: credential })
    .safeParse({ clientId: env.FLUID_EUIPO_CLIENT_ID, clientSecret: env.FLUID_EUIPO_CLIENT_SECRET });
  // Sandbox is available only to the isolated adapter test helper, never as live app evidence.
  return {
    namecom:
      env.FLUID_NAMECOM_CHECKS_ENABLED === "true" && namecom.success && namecom.data.environment === "production"
        ? namecom.data
        : null,
    rdap: env.FLUID_RDAP_CHECKS_ENABLED !== "false",
    vercel: env.FLUID_VERCEL_DOMAIN_CHECKS_ENABLED !== "false",
    cloudflare: env.FLUID_CLOUDFLARE_CHECKS_ENABLED === "true" && cloudflare.success ? cloudflare.data : null,
    youtube: env.FLUID_YOUTUBE_CHECKS_ENABLED === "true" && youtube.success ? youtube.data : null,
    euipo: env.FLUID_EUIPO_CHECKS_ENABLED === "true" && euipo.success ? euipo.data : null,
  };
}
