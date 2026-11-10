import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSupabasePrivateAssetStorage } from "@/server/runtime/private-asset-storage";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const path = `${ownerId}/home/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
function enable() {
  vi.stubEnv("EMBEL_DEVELOPMENT_ENABLED", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3105");
}
afterEach(() => vi.unstubAllEnvs());
it("uses the exact local endpoint only under the explicit matching development gate", async () => {
  enable();
  const transport = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response("brief", { headers: { "content-type": "text/plain" } }),
  );
  const storage = createSupabasePrivateAssetStorage({
    transport,
    scope: { kind: "home", ownerId },
    developmentSupabaseUrl: "http://127.0.0.1:54321",
  });
  expect(await storage.read(path)).toMatchObject({ mimeType: "text/plain" });
  expect(transport.mock.calls[0]![0]).toBe(`http://127.0.0.1:54321/storage/v1/object/fluid-assets/${path}`);
  vi.stubEnv("EMBEL_DEVELOPMENT_ENABLED", "false");
  await expect(storage.read(path)).rejects.toMatchObject({ code: "integration_unavailable" });
  expect(transport).toHaveBeenCalledOnce();
});
it("retains the hosted default and rejects cross-origin, hosted and disabled overrides before I/O", async () => {
  enable();
  const transport = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response("brief", { headers: { "content-type": "text/plain" } }),
  );
  for (const developmentSupabaseUrl of ["http://127.0.0.1:54322", "https://external.example"]) {
    expect(() =>
      createSupabasePrivateAssetStorage({ transport, scope: { kind: "home", ownerId }, developmentSupabaseUrl }),
    ).toThrow();
  }
  vi.stubEnv("NODE_ENV", "production");
  expect(() =>
    createSupabasePrivateAssetStorage({
      transport,
      scope: { kind: "home", ownerId },
      developmentSupabaseUrl: "http://127.0.0.1:54321",
    }),
  ).toThrow();
  await createSupabasePrivateAssetStorage({ transport, scope: { kind: "home", ownerId } }).read(path);
  expect(transport.mock.calls[0]![0]).toBe(
    `https://fricsfwqibyhemknqgyf.supabase.co/storage/v1/object/fluid-assets/${path}`,
  );
});
