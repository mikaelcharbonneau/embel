import { afterEach, expect, it, vi } from "vitest";
import { createInspirationClient } from "@/components/inspiration/inspiration-client";
import { createInspirationMemory } from "@/components/inspiration/inspiration-memory";
import { INSPIRATION_CATALOG_VERSION } from "@/domain/inspiration";
const account = { status: "ready" as const, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 },
  projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const overview = {
  ownerId: account.userId,
  projectId,
  projectTitle: "Fixture",
  projectScope: "complete_brand",
  projectRevision: 1,
  catalogVersion: INSPIRATION_CATALOG_VERSION,
  selectionRevision: 0,
  choices: [],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("hides recovery while rechecking, recovers only the same owner, rejects old generations and clears on owner switch", () => {
  const memory = createInspirationMemory(),
    intent = {
      desired: { ensemble: true, elements: [] },
      expectedRevision: 0,
      expectedProjectRevision: 1,
      checked: false,
      error: "unconfirmed",
    };
  memory.bind(account);
  memory.put(account, projectId, "design", intent);
  memory.bind(null);
  expect(memory.get(account, projectId).size).toBe(0);
  expect(memory.hasUnsaved()).toBe(true);
  const fresh = { ...account, generation: 2 };
  memory.bind(fresh);
  expect(memory.get(fresh, projectId).size).toBe(1);
  memory.put(account, projectId, "late", intent);
  expect(memory.get(fresh, projectId).size).toBe(1);
  memory.bind({ ...fresh, userId: projectId });
  memory.bind(fresh);
  expect(memory.hasUnsaved()).toBe(false);
});
it("bounds hanging transport at 15 seconds and ignores late account responses", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetcher);
  const client = createInspirationClient(account, projectId, () => true, vi.fn());
  const pending = expect(client.read()).rejects.toMatchObject({ status: 408 });
  await vi.advanceTimersByTimeAsync(15001);
  await pending;
  expect(fetcher.mock.calls).toHaveLength(1);
  let current = true;
  let resolve!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  const fenced = createInspirationClient(account, projectId, () => current, vi.fn());
  const result = fenced.read();
  current = false;
  resolve(Response.json(overview));
  expect(await result).toBeNull();
});
it("rejects foreign/malformed/oversized receipts and enforces same-origin noncached requests", async () => {
  const expire = vi.fn(),
    fetcher = vi.fn().mockResolvedValue(Response.json(overview));
  vi.stubGlobal("fetch", fetcher);
  const client = createInspirationClient(account, projectId, () => true, expire);
  expect(await client.read()).toEqual(overview);
  expect(fetcher).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store" }),
  );
  fetcher.mockResolvedValue(Response.json({ ...overview, ownerId: projectId }));
  expect(await client.read()).toBeNull();
  expect(expire).toHaveBeenCalledWith(account);
  fetcher.mockResolvedValue(Response.json({ ...overview, choices: [{}] }));
  await expect(client.read()).rejects.toMatchObject({ status: 502 });
  fetcher.mockResolvedValue(Response.json({ payload: "x".repeat(140000) }));
  await expect(client.read()).rejects.toMatchObject({ status: 502 });
});
