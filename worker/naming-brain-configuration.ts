import { z } from "zod";
import { createNamingBrainPolicy } from "../src/server/ai/naming-brain/policy";
import type { NamingBrainPolicy } from "../src/domain/naming-brain";

export type NamingBrainConfiguration = { apiKey: string; databaseUrl: string; deploymentId: string; paidDispatchEnabled: boolean; policy: NamingBrainPolicy };
export function readNamingBrainConfiguration(env: Record<string, string | undefined> = process.env): NamingBrainConfiguration | null {
  const parsed = z.object({ apiKey: z.string().min(16).max(500).regex(/^\S+$/u), model: z.string().trim().min(1).max(150), databaseUrl: z.url({ protocol: /^postgres(?:ql)?$/ }), deploymentId: z.string().min(1).max(200) }).safeParse({ apiKey: env.OPENAI_API_KEY, model: env.FLUID_NAMING_BRAIN_MODEL, databaseUrl: env.FLUID_NAMING_BRAIN_DATABASE_URL, deploymentId: env.FLUID_NAMING_BRAIN_DEPLOYMENT_ID });
  if (!parsed.success || !(env.FLUID_OPENAI_VERIFIED_MODELS ?? "").split(",").map(value => value.trim()).includes(parsed.data.model)) return null;
  return { apiKey: parsed.data.apiKey, databaseUrl: parsed.data.databaseUrl, deploymentId: parsed.data.deploymentId, paidDispatchEnabled: env.FLUID_NAMING_BRAIN_ENABLED === "true" && env.FLUID_PAID_CALLS_APPROVED === "true", policy: createNamingBrainPolicy(parsed.data.model) };
}
/** Readiness is a paid-dispatch gate; losing it never discards known-session observation. */
export async function startNamingReadiness(report: () => Promise<boolean>, unavailable: () => void = () => {}): Promise<{ assertReady(): Promise<void>; stop(): Promise<void> }> {
  let stopped = false, reporting: Promise<boolean> | undefined;
  // Timer and dispatch checks share one probe on the small worker pool. Track it
  // before invoking report, including synchronous throws and reentrant callers.
  const refresh = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    reporting ??= Promise.resolve().then(() => stopped ? false : report()).catch(() => false).then(ready => {
      if (!ready && !stopped) unavailable();
      return ready;
    }).finally(() => { reporting = undefined; });
    return reporting;
  };
  await refresh();
  const timer = setInterval(() => { void refresh(); }, 20_000);
  timer.unref();
  return {
    async assertReady() {
      if (stopped) throw new Error("naming_readiness_stopped");
      const ready = await refresh();
      if (stopped) throw new Error("naming_readiness_stopped");
      if (!ready) throw new Error("naming_readiness_unavailable");
    },
    async stop() {
      // Fence immediately, before draining either a manual or timer refresh.
      stopped = true;
      clearInterval(timer);
      await reporting;
    },
  };
}

/** Build fingerprint of the shared implementation; the source-byte regression must
 * change with this value. Runtime Unicode/ICU versions are independently bound. */
export const NAMING_PREFERENCES_IMPLEMENTATION_HASH = "7108319323898692a388fcf17cb542509583288b0d4b05d7384f8c5b707aeb01";
export function namingPreferencesRuntimeFingerprint() {
  if (!process.versions.node || !process.versions.icu || !process.versions.unicode) throw new Error("naming_normalizer_unavailable");
  return { version: 1, normalizer: "naming-preferences-v1:nfc-lower-nfc", implementationHash: NAMING_PREFERENCES_IMPLEMENTATION_HASH, nodeVersion: process.versions.node, icuVersion: process.versions.icu, unicodeVersion: process.versions.unicode };
}
