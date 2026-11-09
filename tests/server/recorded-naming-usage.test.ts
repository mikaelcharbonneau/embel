import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { listRecordedUsage } from "../../src/server/data/recorded-usage";
import type { AuthenticatedContext } from "../../src/server/auth/context";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const naming = "11111111-1111-4111-8111-111111111111", unsaved = "33333333-3333-4333-8333-333333333333", strategy = "22222222-2222-4222-8222-222222222222";
const job = (id: string, operation: string, finished_at: string) => ({ id, owner_id: owner, project_id: project, operation, billing_mode: "openai_api", state: "succeeded", finished_at });
const jobs = [job(naming, "naming.generate", "2026-11-08T12:00:00Z"), job(unsaved, "naming.generate", "2026-11-08T11:30:00Z"), job(strategy, "strategy.reformulate", "2026-11-08T11:00:00Z")];
const steps = [{ job_id: strategy, owner_id: owner, project_id: project, state: "succeeded", receipt_operation: "strategy.reformulate", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }];
function auth(usage: unknown, error: unknown = null) {
  const rpc = vi.fn(async () => ({ data: usage, error }));
  const client = { rpc, from: (table: string) => {
    let rows: unknown[] = table === "jobs" ? jobs : steps;
    const query = { select: () => query, eq: () => query, order: () => query,
      in: (field: string, values: string[]) => { rows = rows.filter(row => values.includes((row as Record<string, string>)[field]!)); return query; },
      limit: async (count: number) => ({ data: rows.slice(0, count), error: null }) };
    return query;
  } };
  return { auth: { userId: owner, client } as unknown as AuthenticatedContext, rpc };
}

it("shows naming token counts from get_naming_usage and keeps runs without saved rounds unrecorded", async () => {
  const { auth: context, rpc } = auth([{ jobId: naming, inputTokens: 5200, outputTokens: 2100, totalTokens: 7300 }]);
  const result = await listRecordedUsage(context);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("get_naming_usage", { p_jobs: [naming, unsaved] });
  expect(result.entries).toEqual([
    { id: naming, operation: "naming.generate", completedAt: "2026-11-08T12:00:00Z", tokens: { inputTokens: 5200, outputTokens: 2100, totalTokens: 7300 } },
    { id: unsaved, operation: "naming.generate", completedAt: "2026-11-08T11:30:00Z", tokens: null },
    { id: strategy, operation: "strategy.reformulate", completedAt: "2026-11-08T11:00:00Z", tokens: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
  ]);
});

it("leaves an inconsistent total unknown rather than inventing one", async () => {
  const { auth: context } = auth([{ jobId: naming, inputTokens: 100, outputTokens: 50, totalTokens: 999 }]);
  expect((await listRecordedUsage(context)).entries[0]!.tokens).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: null });
});

it.each([
  ["another job's usage", [{ jobId: strategy, inputTokens: 1, outputTokens: 1, totalTokens: 2 }], null],
  ["a repeated job", [{ jobId: naming, inputTokens: 1, outputTokens: 1, totalTokens: 2 }, { jobId: naming, inputTokens: 1, outputTokens: 1, totalTokens: 2 }], null],
  ["a malformed row", [{ jobId: naming, inputTokens: -1, outputTokens: 1, totalTokens: 0 }], null],
  ["a database error", null, { code: "XX000", message: "private detail" }],
])("fails closed on %s", async (_case, usage, error) => {
  await expect(listRecordedUsage(auth(usage, error).auth)).rejects.toMatchObject({ code: "integration_unavailable" });
});
