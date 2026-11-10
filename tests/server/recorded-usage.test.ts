import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { listRecordedUsage } from "../../src/server/data/recorded-usage";
import type { AuthenticatedContext } from "../../src/server/auth/context";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const api = "11111111-1111-4111-8111-111111111111", subscription = "22222222-2222-4222-8222-222222222222";
function auth(jobs: unknown[], steps: unknown[]) {
  return { userId: owner, client: { from: (table: string) => {
    let rows = table === "jobs" ? jobs : table === "job_steps" ? steps : [];
    const query = { select: () => query, eq: () => query, order: () => query,
      in: (field: string, values: string[]) => { rows = rows.filter(row => values.includes((row as Record<string, string>)[field]!)); return query; },
      limit: async (count: number) => ({ data: rows.slice(0, count), error: null }) };
    return query;
  } } } as unknown as AuthenticatedContext;
}
const job = (id: string, billing_mode: string) => ({ id, owner_id: owner, project_id: project, operation: "strategy.competitors", billing_mode, state: "succeeded", finished_at: "2026-11-01T12:00:00Z" });
const step = (job_id: string, usage: unknown) => ({ job_id, owner_id: owner, project_id: project, state: "succeeded", receipt_operation: "strategy.competitors", usage });

it("reports the request total for API receipts that record only input and output", async () => {
  const result = await listRecordedUsage(auth([job(api, "openai_api"), job(subscription, "chatgpt_subscription")], [
    step(api, { inputTokens: 1200, outputTokens: 345, cachedInputTokens: 200, cacheWriteInputTokens: 0, webSearchCalls: 1 }),
    step(subscription, { inputTokens: 10, outputTokens: 4, totalTokens: 14 }),
  ]));
  expect(result.entries.map(entry => entry.tokens)).toEqual([
    { inputTokens: 1200, outputTokens: 345, totalTokens: 1545 },
    { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  ]);
});

it("keeps a request without a usage receipt unrecorded instead of inventing a count", async () => {
  const result = await listRecordedUsage(auth([job(api, "openai_api")], [step(api, null)]));
  expect(result.entries[0]!.tokens).toBeNull();
});
