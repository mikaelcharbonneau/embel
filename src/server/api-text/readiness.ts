import "server-only";
import { z } from "zod";
import { apiTextDeploymentSchema } from "../../domain/api-text-dispatch";
import { strategyOperationSchema } from "../../domain/strategy-jobs";
import { getApiTextPublicationOrigin } from "./config";
import { getApiTextPublisherToken } from "./publisher-token";

const readinessSchema = z.strictObject({
  version: z.literal(1), deploymentId: apiTextDeploymentSchema.regex(/^dpl_[A-Za-z0-9_-]{1,196}$/),
  operations: z.array(strategyOperationSchema).max(6)
    .refine(operations => new Set(operations).size === operations.length),
});
export type ApiTextWorkerReadiness = z.infer<typeof readinessSchema>;

/** Reachability and existing worker approval only; SQL still owns caller eligibility. */
export async function getApiTextWorkerReadiness(): Promise<ApiTextWorkerReadiness | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(controller.signal), new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, 12_000);
    })]);
  } finally { clearTimeout(timer); controller.abort(); }
}

async function read(signal: AbortSignal): Promise<ApiTextWorkerReadiness | null> {
  try {
    const origin = getApiTextPublicationOrigin();
    if (!origin) return null;
    const token = await getApiTextPublisherToken();
    if (!token) return null;
    signal.throwIfAborted();
    const response = await fetch(`${origin}/api/readiness`, {
      method: "GET", cache: "no-store", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "x-vercel-trusted-oidc-idp-token": token },
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    let text = ""; let size = 0;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      while (true) {
        const next = await reader.read(); if (next.done) break;
        signal.throwIfAborted();
        size += next.value.byteLength;
        if (size > 1_024) { void reader.cancel(); return null; }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    signal.throwIfAborted();
    return readinessSchema.parse(JSON.parse(text));
  } catch { return null; }
}
