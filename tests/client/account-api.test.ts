import { afterEach, describe, expect, it, vi } from "vitest";
import { accountSessionSchema, PROJECT_MUTATION_MAX_BYTES } from "@/domain/project-api";
import { createProjectInputSchema } from "@/domain/projects";
import { accountErrorMessage, accountRequest } from "@/components/workspace/account-api";

afterEach(() => vi.unstubAllGlobals());
describe("private account request boundary", () => {
  it("rejects a schema-valid multibyte brief before any network request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const input = createProjectInputSchema.parse({ title: "Local size fixture", scope: "naming_only", context: { description: "食".repeat(12000) } });
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(PROJECT_MUTATION_MAX_BYTES);
    await expect(accountRequest("/api/projects", accountSessionSchema, { method: "POST", body: input, signal: new AbortController().signal })).rejects.toMatchObject({ status: 413 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses same-origin credentials and bypasses the browser cache", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: "aaaaaaaa-1111-4111-8111-111111111111" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await accountRequest("/api/session", accountSessionSchema, { signal: new AbortController().signal });
    expect(fetch).toHaveBeenCalledWith("/api/session", expect.objectContaining({ credentials: "same-origin", mode: "same-origin", cache: "no-store" }));
  });
  it("does not pass malformed successful responses or server error details into the UI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"user":{"id":"malformed"}}', { status: 200 })));
    await expect(accountRequest("/api/session", accountSessionSchema, { signal: new AbortController().signal })).rejects.toMatchObject({ status: 502 });
    expect(accountErrorMessage(new Error("private server detail"))).not.toContain("private server detail");
  });
});
