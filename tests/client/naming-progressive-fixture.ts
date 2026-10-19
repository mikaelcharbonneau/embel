import { vi } from "vitest";
import { createNamingFeedController } from "@/components/naming/naming-feed-controller";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import type { EnsureNamingRunIntent, NamingBrainRunSummary, NamingFeed, NamingFeedEntry } from "@/domain/naming-brain";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { contextSnapshotSchema } from "@/domain/projects";
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey } from "@/domain/project-naming";

export const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const account = { userId: id(1), generation: 1 }, projectId = id(2), when = "2026-10-18T12:00:00Z";
const context = contextSnapshotSchema.parse({ description: "Synthetic progressive feed fixture" });
export function entry(n: number): NamingFeedEntry {
  const value = `Synthetic ${n}`, candidateId = id(n + 1000);
  return { entryId: id(n + 2000), position: n, runId: null, steeringRevision: 0, primaryApproach: null, additionalApproaches: [], publishedClaims: [], entry: {
    candidate: { id: candidateId, ownerId: account.userId, projectId, value, identityKey: nameIdentityKey(value), rationale: "Synthetic user-authored fixture", contextRevision: 1,
      strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt: when,
      origin: { kind: "local_import", ownerId: account.userId, projectId, candidateId, contextRevision: 1, source: { id: id(n + 3000), value, createdAt: when, origin: "manual", history: [] }, capturedContext: context } },
    retention: { ownerId: account.userId, projectId, candidateId, revision: n === 100 ? 1 : 0, favorite: n === 100, saved: false, updatedAt: n === 100 ? when : null },
  } };
}
export const entries = (start: number, count: number) => Array.from({ length: count }, (_, i) => entry(start + i));
export const cursor = (position: number) => ({ entryId: entry(position).entryId, position });
export function run(state: NamingBrainRunSummary["state"] = "succeeded"): NamingBrainRunSummary {
  return { version: 1, ownerId: account.userId, projectId, runId: id(10), jobId: id(11), batchId: id(12), revision: 7, resumedFromRunId: null, canResume: false,
    state, projectRevision: 1, preferencesVersion: 1, feedbackRevision: 1, steeringRevision: 0, demandSequence: 2, snapshotHash: "b".repeat(64), acceptedPolicyIdentity: "a".repeat(64),
    progress: state === "succeeded" ? 100 : 20, preparedSetId: state === "succeeded" ? id(13) : null,
    fulfillment: state === "succeeded" ? { status: "complete", targetCount: 100, acceptedCount: 100, missingCount: 0, coverageSatisfied: true, message: null } : null,
    accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: when, updatedAt: when };
}
export function feed(rows = entries(201, 100)): NamingFeed {
  return { version: 1, ownerId: account.userId, projectId, projectRevision: 1, preferencesVersion: 1, feedbackRevision: 1, steeringRevision: 0, demandSequence: 2,
    canPrefetchOnScroll: true, retentionRevision: 1, entries: rows, nextCursor: null, consumedThrough: cursor(200), activeRun: run(), preparedSetId: null,
    paused: false, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: "a".repeat(64) } };
}
export function fixture(initial = feed(), retained = entries(1, 300)) {
  let latest = initial, visible = true, eligible = true;
  const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  memory.connectPreferences(account, projectId, { ownerId: account.userId, projectId, version: 1, createdAt: when,
    preferences: { ...initialNamingPreferencesV2(context), approaches: ["real_words"], directness: "open_ended" } }, context);
  memory.setFeed(account, projectId, value => ({ ...value, entries: retained }));
  const requests: { path: string; method: string; body: unknown }[] = [];
  let respond = async (path: string, options: { method?: string; body?: unknown }): Promise<unknown> => {
    if (path.endsWith("/feed/stop")) return { feed: { ...latest, paused: true, state: "paused", demandSequence: latest.demandSequence + 1 } };
    if (options.method !== "POST") return { feed: latest };
    const intent = options.body as EnsureNamingRunIntent;
    const activeRun = { ...run("queued"), runId: id(20) };
    latest = { ...latest, activeRun, progressive: { version: 1, targetCount: 100, publishedCount: 0 }, consumedThrough: intent.consumedThrough };
    delete latest.canPrefetchOnScroll;
    return { status: "pending", feed: latest, run: activeRun, reused: false };
  };
  const request = vi.fn(async (path: string, _schema: unknown, options: { method?: string; body?: unknown }) => {
    requests.push({ path, method: options.method ?? "GET", body: options.body }); return respond(path, options);
  });
  const controller = createNamingFeedController({ account, projectId, memory, request: request as never, eligible: () => eligible, visible: () => visible });
  return { controller, memory, request, requests, setFeed: (next: NamingFeed) => { latest = next; }, respond: (next: typeof respond) => { respond = next; },
    visible: (value: boolean) => { visible = value; }, eligible: (value: boolean) => { eligible = value; }, posts: () => requests.filter(row => row.path.endsWith("/feed/ensure")) };
}
