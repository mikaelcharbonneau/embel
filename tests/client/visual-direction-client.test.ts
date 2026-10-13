import { afterEach, expect, it, vi } from "vitest";
import { createVisualDirectionClient } from "@/features/identity-directions/components/visual-direction-client";
import { visualOverview, visualOwner, visualProject } from "../fixtures/visual-direction";
const account = { status: "ready" as const, userId: visualOwner, generation: 1 };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("bounds response bytes, verifies receipt ownership and ignores a late response after owner replacement", async () => {
  let active = true; const expire = vi.fn(), client = createVisualDirectionClient(account, visualProject, () => active, expire);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(786433), { headers: { "content-type": "application/json" } })));
  await expect(client.read()).rejects.toMatchObject({ status: 502 });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(visualOverview({ ownerId: visualProject }))));
  expect(await client.read()).toBeNull(); expect(expire).toHaveBeenCalledWith(account);
  let resolve!: (response: Response) => void; vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(yes => { resolve = yes; })));
  const pending = client.read(); active = false; resolve(Response.json(visualOverview({ reviewed: true })));
  expect(await pending).toBeNull(); client.dispose();
});
it("times out an unresolved request and aborts it without repeating it", async () => {
  vi.useFakeTimers(); let signal: AbortSignal | undefined;
  const fetcher = vi.fn((_path: string, init: RequestInit) => { signal = init.signal!; return new Promise<Response>(() => undefined); }); vi.stubGlobal("fetch", fetcher);
  const client = createVisualDirectionClient(account, visualProject, () => true, vi.fn());
  const result = expect(client.read()).rejects.toMatchObject({ status: 408 });
  await vi.advanceTimersByTimeAsync(15001); await result;
  expect(signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1); client.dispose();
});
