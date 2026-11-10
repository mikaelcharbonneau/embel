import "server-only";
import { type StandaloneLookupResult } from "@/domain/standalone-live-checks";
import { createSocialProfileContract } from "./social-profile";
import { toHandleEvidence } from "./projections";
import { type HandleTarget, type ProviderClock, type ProviderFetch } from "./contracts";

export async function lookupYoutube(
  target: HandleTarget,
  apiKey: string,
  fetcher: ProviderFetch,
  clock: ProviderClock,
  signal: AbortSignal,
): Promise<StandaloneLookupResult> {
  const contract = createSocialProfileContract({
    clock,
    fetch: async (request) => {
      const expected = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(target.handle)}`;
      if (request.url !== expected || request.method !== "GET" || request.redirect !== "error")
        throw new Error("Invalid provider request");
      // Google documents the header form, which keeps the key out of URLs and logs.
      const headers = new Headers(request.headers);
      headers.set("X-Goog-Api-Key", apiKey);
      return fetcher(new Request(request, { headers }));
    },
  });
  const result = await contract.check(target, signal);
  if (result.status === "failed")
    return { status: "failed", code: result.code, retryAfterSeconds: result.retryAfterSeconds };
  return { status: "handle", evidence: toHandleEvidence(result, target, clock()) };
}
