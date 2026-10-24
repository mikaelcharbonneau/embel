import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// This suite exercises the synthetic execution contract, not real provider readiness.
vi.mock("@/server/ai/naming-brain/budget-availability", async importOriginal => ({ ...await importOriginal<typeof import("@/server/ai/naming-brain/budget-availability")>(), isNamingProviderBudgetAvailable: () => true }));
const mock = vi.hoisted(() => ({ verify: vi.fn(), rpc: vi.fn() }));
vi.mock("@/server/data/project-naming", () => ({ verifyProjectNameCandidates: mock.verify }));
vi.mock("@/server/api-text/config", () => ({ isHostedNamingRuntime: () => true, isLocalPrototypeRuntime: () => false }));
import { getNamingFeed } from "@/server/data/naming-brain";
import type { AuthenticatedContext } from "@/server/auth/context";
const ownerId = "a0000000-0000-4000-8000-000000000001", projectId = "b0000000-0000-4000-8000-000000000001";
const feed = { version: 1, ownerId, projectId, projectRevision: 1, preferencesVersion: 1, steeringRevision: 0, feedbackRevision: 0, demandSequence: 0, entries: [], nextCursor: null, consumedThrough: null, activeRun: null, preparedSetId: null, paused: false, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: "a".repeat(64) } };
const auth = { userId: ownerId, client: { rpc: mock.rpc } } as unknown as AuthenticatedContext;
beforeEach(() => { vi.resetAllMocks(); mock.verify.mockResolvedValue(undefined); });

it.each(["timeout", "invalid", "transport"])("retains the verified saved feed when hosted readiness has a %s failure", async failure => {
  mock.rpc.mockImplementation(async (name: string) => {
    if (name === "get_naming_feed") return { data: feed, error: null };
    if (failure === "transport") throw Error("Synthetic offline readiness");
    return failure === "timeout" ? { data: null, error: { code: "57014" } } : { data: { status: "broken" }, error: null };
  });
  const result = await getNamingFeed(auth, projectId);
  expect(result).toMatchObject({ ownerId, projectId, entries: [], availability: { status: "unavailable", code: "naming_runtime_unavailable" } });
  expect(result.canResumeOnScroll).toBeUndefined(); expect(result.canPrefetchOnScroll).toBeUndefined();
  expect(mock.verify).toHaveBeenCalledExactlyOnceWith(auth, projectId, []);
  expect(mock.rpc.mock.calls.every(([name]) => name.startsWith("get_"))).toBe(true);
});

it.each([["P0002", "not_found"], ["PGRST301", "unauthenticated"], ["PGRST302", "unauthenticated"], ["PGRST303", "unauthenticated"], ["42501", "unauthenticated"]])("retains readiness authorization failure %s instead of concealing it as an outage", async (code, expected) => {
  mock.rpc.mockImplementation(async (name: string) => name === "get_naming_feed" ? { data: feed, error: null } : { data: null, error: { code } });
  await expect(getNamingFeed(auth, projectId)).rejects.toMatchObject({ code: expected, status: expected === "not_found" ? 404 : 401 });
});

it.each(["PGRST301", "PGRST302", "PGRST303", "42501"])("does not continue saved-feed verification after %s rejects authentication", async code => {
  mock.rpc.mockResolvedValue({ data: null, error: { code, message: "unauthenticated" } });
  await expect(getNamingFeed(auth, projectId)).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  expect(mock.verify).not.toHaveBeenCalled(); expect(mock.rpc).toHaveBeenCalledTimes(1);
});

it("never conceals failed saved-name provenance verification", async () => {
  mock.rpc.mockResolvedValue({ data: feed, error: null }); mock.verify.mockRejectedValue(Error("Synthetic invalid provenance"));
  await expect(getNamingFeed(auth, projectId)).rejects.toThrow("Synthetic invalid provenance");
  expect(mock.rpc).toHaveBeenCalledTimes(1);
});
