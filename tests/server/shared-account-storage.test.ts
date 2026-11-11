import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createAccountHomeStorageTransport } from "../../src/server/runtime/account-home-storage";
import { createSupabasePrivateAssetStorage } from "../../src/server/runtime/private-asset-storage";
import type { AuthenticatedContext } from "../../src/server/auth/context";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  path = `${owner}/home/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
const key = "sb_publishable_inertfixture",
  staging = "https://abcdefghijklmnopqrst.supabase.co";
const user = { id: owner, is_anonymous: false, email_confirmed_at: "2026-10-01T00:00:00Z" };
function auth(
  verified: { id: string; is_anonymous: boolean; email_confirmed_at: string | null } = user,
): AuthenticatedContext {
  return {
    userId: owner,
    client: {
      auth: {
        getSession: async () => ({ data: { session: { user, access_token: "inert.customer.token" } }, error: null }),
        getUser: async () => ({ data: { user: verified }, error: null }),
      },
    },
  } as unknown as AuthenticatedContext;
}
function configure(origin = staging) {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", key);
  vi.stubEnv("NODE_ENV", "test");
}
describe("shared Home Storage remains customer JWT and exact selected target", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses the explicit staging target, ordinary verified token and private immutable paths", async () => {
    configure();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("brief", { headers: { "content-type": "text/plain" } }),
    );
    const transport = await createAccountHomeStorageTransport(auth(), {
      fetch,
      publishableKey: key,
      sharedSupabaseOrigin: staging,
    });
    const storage = createSupabasePrivateAssetStorage({
      transport,
      scope: { kind: "home", ownerId: owner },
      sharedSupabaseOrigin: staging,
    });
    expect(await storage.read(path)).toMatchObject({
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("brief"),
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${staging}/storage/v1/object/authenticated/fluid-assets/${path}`);
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer inert.customer.token");
    expect(init).toMatchObject({ redirect: "error", cache: "no-store", credentials: "omit" });
    await expect(storage.read(path.replace(owner, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"))).rejects.toMatchObject({
      code: "not_found",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("cannot select another origin or overwrite caller authorization, and rechecks target changes before IO", async () => {
    configure();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("brief"));
    await expect(
      createAccountHomeStorageTransport(auth(), {
        fetch,
        publishableKey: key,
        sharedSupabaseOrigin: "https://fricsfwqibyhemknqgyf.supabase.co",
      }),
    ).rejects.toMatchObject({ code: "integration_unavailable" });
    const transport = await createAccountHomeStorageTransport(auth(), {
      fetch,
      publishableKey: key,
      sharedSupabaseOrigin: staging,
    });
    await expect(
      transport(`${staging}/storage/v1/object/authenticated/fluid-assets/${path}`, {
        method: "GET",
        headers: { authorization: "Bearer caller" },
      }),
    ).rejects.toMatchObject({ code: "integration_unavailable" });
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fricsfwqibyhemknqgyf.supabase.co");
    await expect(
      transport(`${staging}/storage/v1/object/authenticated/fluid-assets/${path}`, { method: "GET" }),
    ).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["http://127.0.0.1:54321", "http://127.0.0.1:55421"])(
    "local target %s requires the exact development gate and cannot become a hosted HTTP override",
    async (local) => {
      configure(local);
      vi.stubEnv("EMBEL_DEVELOPMENT_ENABLED", "true");
      vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3155");
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response("brief", { headers: { "content-type": "text/plain" } }),
      );
      const transport = await createAccountHomeStorageTransport(auth(), {
        fetch,
        publishableKey: key,
        sharedSupabaseOrigin: local,
      });
      const storage = createSupabasePrivateAssetStorage({
        transport,
        scope: { kind: "home", ownerId: owner },
        sharedSupabaseOrigin: local,
      });
      await storage.read(path);
      expect(fetch.mock.calls[0]![0]).toBe(`${local}/storage/v1/object/authenticated/fluid-assets/${path}`);
      vi.stubEnv("VERCEL", "1");
      await expect(storage.read(path)).rejects.toMatchObject({ code: "integration_unavailable" });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it("provider-unconfirmed or mismatched accounts cannot obtain Storage transport", async () => {
    configure();
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createAccountHomeStorageTransport(auth({ ...user, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }), {
        fetch,
        publishableKey: key,
        sharedSupabaseOrigin: staging,
      }),
    ).rejects.toMatchObject({ code: "integration_unavailable" });
    await expect(
      createAccountHomeStorageTransport(auth({ ...user, email_confirmed_at: null }), {
        fetch,
        publishableKey: key,
        sharedSupabaseOrigin: staging,
      }),
    ).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
