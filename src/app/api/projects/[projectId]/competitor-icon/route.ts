import { z } from "zod";
import { getAuthenticatedContext } from "@/server/auth/context";
import { competitorIconHost, competitorIconHostOfUrl, createCompetitorIconFetcher, type CompetitorIcon } from "@/server/competitor-icons";
import { getProject } from "@/server/data/projects";
import { getStrategyOverview } from "@/server/data/strategy-jobs";
import { ApiError, errorResponse } from "@/server/http/errors";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };

const fetchIcon = createCompetitorIconFetcher();
// Per owner, so one account's research never reveals another's. Bounded and
// in memory only; the browser keeps its own private copy for a week.
const cache = new Map<string, { icon: CompetitorIcon | null; expires: number }>();
const CACHE_ENTRIES = 500, HIT_MS = 7 * 86_400_000, MISS_MS = 86_400_000;

/** Competitor websites saved in the project or proposed in its own research results. */
function competitorHosts(values: unknown[]): Set<string> {
  const hosts = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || hosts.size > 200 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string" && typeof record.relevance === "string") {
      const host = competitorIconHostOfUrl(record.url);
      if (host) hosts.add(host);
    }
    for (const item of Object.values(record)) visit(item, depth + 1);
  };
  for (const value of values) visit(value, 0);
  return hosts;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    const projectId = z.uuid().safeParse((await context.params).projectId);
    const host = competitorIconHost(new URL(request.url).searchParams.get("host"));
    if (!projectId.success || !host) throw new ApiError("not_found");
    const project = await getProject(auth, projectId.data);
    let allowed = competitorHosts([project.context.competitors]);
    if (!allowed.has(host)) {
      const overview = await getStrategyOverview(auth, projectId.data);
      allowed = competitorHosts([overview.jobs.map(job => job.results.map(result => result.output))]);
    }
    if (!allowed.has(host)) throw new ApiError("not_found");
    const key = `${auth.userId}:${host}`;
    let entry = cache.get(key);
    if (!entry || entry.expires < Date.now()) {
      const icon = await fetchIcon(host, request.signal);
      entry = { icon, expires: Date.now() + (icon ? HIT_MS : MISS_MS) };
      cache.delete(key); cache.set(key, entry);
      while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    }
    if (!entry.icon) throw new ApiError("not_found");
    return new Response(new Uint8Array(entry.icon.bytes), { headers: {
      "Content-Type": entry.icon.contentType, "Cache-Control": "private, max-age=604800", "Vary": "Cookie",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
    } });
  } catch (error) { return errorResponse(error); }
}
