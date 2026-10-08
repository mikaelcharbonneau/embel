import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthenticatedContext } from "../../../src/server/auth/context";
import { createAccountLogoClient } from "../../../src/components/identity/account-logo-client";
import { logoVectorHistoryPageSchema, logoVectorHistoryQuerySchema, type LogoVectorHistoryPage } from "../../../src/features/logo-vector/model/history";
import { listLogoVectorHistory } from "../../../src/features/logo-vector/server/history";
import { createVectorHttpFixture, ownerId, projectId, base } from "./http-fixture";

function page(): LogoVectorHistoryPage {
  const f = createVectorHttpFixture(), revision = f.initial.revision;
  return { ownerId, projectId, workspaceRevision: 2, items: [{ vectorRevisionId: revision.id, parentRevisionId: null,
    createdAt: revision.createdAt, source: revision.source, lockCount: 0, selection: "retained", acceptance: "unaccepted", earlierInputs: false, cancellation: "none", stageRevision: null }], nextCursor: null };
}
function auth(value: unknown) {
  const rpc = vi.fn(() => {
    const result = Promise.resolve({ data: value, error: null });
    return Object.assign(result, { abortSignal: vi.fn(() => result) });
  });
  return { rpc, context: { userId: ownerId, client: { rpc } } as unknown as AuthenticatedContext };
}
const account = { status: "ready" as const, userId: ownerId, generation: 1 };
describe("bounded owned vector discovery", () => {
  it("validates independent selection, acceptance, cancellation and earlier-input projections", () => {
    const value = page(); value.items[0] = { ...value.items[0]!, selection: "retained", acceptance: "approved", earlierInputs: true, cancellation: "cancelled" };
    expect(logoVectorHistoryPageSchema.parse(value)).toEqual(value);
    expect(logoVectorHistoryPageSchema.safeParse({ ...value, items: [...value.items, ...value.items] }).success).toBe(false);
    expect(logoVectorHistoryPageSchema.safeParse({ ...value, items: [{ ...value.items[0], stageRevision: { stage: "concepts", id: projectId, revision: 1 } }] }).success).toBe(false);
    expect(logoVectorHistoryQuerySchema.safeParse({ cursor: "not opaque json {}" }).success).toBe(false);
    expect(logoVectorHistoryQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
  });
  it("uses the fixed authenticated owner-scoped RPC without writing or reading geometry", async () => {
    const value = page(), f = auth(value);
    expect(await listLogoVectorHistory(f.context, projectId, { limit: 1 })).toEqual(value);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith("list_logo_vector_history", { p_project_id: projectId, p_query: { limit: 1 } });
  });
  it("rejects foreign scope, oversized counts and aborted responses", async () => {
    const value = page(); const foreign = auth({ ...value, ownerId: projectId });
    await expect(listLogoVectorHistory(foreign.context, projectId)).rejects.toMatchObject({ code: "not_found" });
    const extra = auth({ ...value, items: [value.items[0], { ...value.items[0], vectorRevisionId: projectId }] });
    await expect(listLogoVectorHistory(extra.context, projectId, { limit: 1 })).rejects.toMatchObject({ code: "integration_unavailable" });
    const controller = new AbortController(); controller.abort(); const stopped = auth(value);
    await expect(listLogoVectorHistory(stopped.context, projectId, {}, controller.signal)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(stopped.rpc).not.toHaveBeenCalled();
  });
  it("uses one bounded GET and rejects foreign pages or pages beyond the requested limit", async () => {
    const value = page(), fetcher = vi.fn<typeof fetch>(async () => Response.json(value));
    const client = createAccountLogoClient(account, projectId, () => true, () => {}, fetcher);
    expect(await client.listLogoVectorHistory({ limit: 1 })).toEqual(value);
    expect(fetcher.mock.calls[0]![0]).toBe(`${base}/vector/history?limit=1`);
    fetcher.mockResolvedValueOnce(Response.json({ ...value, projectId: ownerId }));
    await expect(client.listLogoVectorHistory()).rejects.toMatchObject({ status: 502 });
    fetcher.mockResolvedValueOnce(Response.json({ ...value, items: [value.items[0], { ...value.items[0], vectorRevisionId: projectId }] }));
    await expect(client.listLogoVectorHistory({ limit: 1 })).rejects.toMatchObject({ status: 502 });
  });
  it.each(["account", "abort"] as const)("fences a late %s history response", async cause => {
    let release!: (response: Response) => void, current = true; const controller = new AbortController();
    const client = createAccountLogoClient(account, projectId, () => current, () => {}, () => new Promise(resolve => { release = resolve; }));
    const pending = client.listLogoVectorHistory({}, controller.signal);
    if (cause === "account") current = false; else controller.abort();
    release(Response.json(page())); expect(await pending).toBeNull();
  });
});
