import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthenticatedContext } from "@/server/auth/context";
import { createLogoOwnerStorageTransport } from "@/server/runtime/logo-owner-storage";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const path = `https://fricsfwqibyhemknqgyf.supabase.co/storage/v1/object/fluid-assets/${owner}/${project}/cccccccc-cccc-4ccc-8ccc-cccccccccccc/dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
const token = "synthetic-request-token", publishableKey = "sb_publishable_synthetic";
function fixture() {
  const getSession = vi.fn(async () => ({ data: { session: { access_token: token, get user(): never { throw new Error("Never authorize session user fields"); } } }, error: null }));
  const getUser = vi.fn(async (_token: string) => { void _token; return { data: { user: { id: owner, is_anonymous: false } }, error: null }; });
  const fetcher = vi.fn<typeof fetch>(async () => new Response("synthetic bytes"));
  const auth = { userId: owner, client: { auth: { getSession, getUser } } } as unknown as AuthenticatedContext;
  return { auth, getSession, getUser, fetcher, dependencies: { publishableKey, fetch: fetcher } };
}
describe("request-only authenticated logo Storage transport", () => {
  it("verifies the exact request token and preserves one fixed owner/project destination", async () => {
    const f = fixture(), transport = await createLogoOwnerStorageTransport(f.auth, project, f.dependencies);
    expect(f.getUser).toHaveBeenCalledExactlyOnceWith(token); expect(f.fetcher).not.toHaveBeenCalled();
    const body = new Uint8Array([1, 2, 3]), signal = new AbortController().signal;
    await transport(path, { method: "POST", headers: { "content-type": "image/png", "x-upsert": "false" }, body, signal });
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(url).toBe(path); expect(init?.body).toBe(body); expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`); expect(new Headers(init?.headers).get("apikey")).toBe(publishableKey);
    expect(new Headers(init?.headers).get("x-upsert")).toBe("false"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    await transport(path, { method: "GET" }); expect(f.getSession).toHaveBeenCalledTimes(1); expect(f.getUser).toHaveBeenCalledTimes(1);
  });
  it.each(["owner", "anonymous", "missing", "error"] as const)("rejects %s token validation without any Storage request", async mode => {
    const f = fixture();
    if (mode === "owner") f.getUser.mockResolvedValue({ data: { user: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", is_anonymous: false } }, error: null });
    if (mode === "anonymous") f.getUser.mockResolvedValue({ data: { user: { id: owner, is_anonymous: true } }, error: null });
    if (mode === "missing") f.getSession.mockResolvedValue({ data: { session: null }, error: null } as never);
    if (mode === "error") f.getUser.mockRejectedValue(new Error(`Untrusted ${token}`));
    const error = await createLogoOwnerStorageTransport(f.auth, project, f.dependencies).catch(error => error);
    expect(error.code).toMatch(/unauthenticated|integration_unavailable/); expect(String(error)).not.toContain(token); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [path.replace("fricsfwqibyhemknqgyf.supabase.co", "foreign.invalid"), { method: "GET" }],
    [path.replace(project, "home"), { method: "GET" }],
    [path.replace(project, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), { method: "GET" }],
    [path + "?redirect=elsewhere", { method: "GET" }],
    [path, { method: "DELETE" }], [path, { method: "POST", headers: { "x-upsert": "true" } }],
    [path, { method: "GET", headers: { authorization: "Bearer unapproved" } }],
  ] as const)("never transmits a token outside the exact immutable object contract %#", async (url, init) => {
    const f = fixture(), transport = await createLogoOwnerStorageTransport(f.auth, project, f.dependencies);
    await expect(transport(url, init)).rejects.toMatchObject({ code: "integration_unavailable" }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("fences a late session result after request cancellation before validating or using its token", async () => {
    const f = fixture(), controller = new AbortController(); let finish!: (value: Awaited<ReturnType<typeof f.getSession>>) => void;
    f.getSession.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const creating = createLogoOwnerStorageTransport(f.auth, project, f.dependencies, controller.signal);
    controller.abort(); finish({ data: { session: { access_token: token } }, error: null } as never);
    await expect(creating).rejects.toMatchObject({ code: "integration_unavailable" }); expect(f.getUser).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("does not refresh, retry or change principals when Storage rejects a request", async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response(null, { status: 401 }));
    const transport = await createLogoOwnerStorageTransport(f.auth, project, f.dependencies);
    expect((await transport(path, { method: "GET" })).status).toBe(401);
    expect(f.getSession).toHaveBeenCalledTimes(1); expect(f.getUser).toHaveBeenCalledTimes(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});
