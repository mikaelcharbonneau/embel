import { z } from "zod";

/** Optional Cloudflare Turnstile token. The browser sends it only when a site key is configured. */
export const captchaTokenField = z.string().min(1).max(2048).optional();

/** Supabase Auth call options for a token; nothing is added when there is none. */
export function captchaOptions(token: string | undefined): { captchaToken?: string } {
  return token ? { captchaToken: token } : {};
}
