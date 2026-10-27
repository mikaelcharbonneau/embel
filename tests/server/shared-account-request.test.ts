import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { issueSharedAccountRequest } from "../../src/server/shared-account/request";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const token = "a".repeat(64);
function auth(data: unknown, error: unknown = null) {
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => { void name; void args; return Promise.resolve({ data, error }); });
  return { context: { userId: owner, client: { rpc } } as unknown as AuthenticatedContext, rpc };
}
const valid = () => ({ version: 1, token, ownerId: owner, expiresAt: new Date(Date.now() + 20_000).toISOString() });
describe("shared request delegation remains provider-derived and request scoped", () => {
  afterEach(() => vi.restoreAllMocks());
  it("uses the ordinary Auth client's owner-free RPC and returns only opaque delegation", async () => {
    const { context, rpc } = auth(valid());
    expect(await issueSharedAccountRequest(context, "home", "readback", [owner])).toBe(token);
    expect(rpc).toHaveBeenCalledWith("issue_shared_account_request", { p_lane: "home", p_action: "readback", p_arguments: [owner] });
    expect(rpc.mock.calls[0]![1]).not.toHaveProperty("ownerId");
  });
  it.each(["foreign", "expired", "long-lived", "malformed", "extra"])('rejects %s provider proof', async kind => {
    const data: Record<string, unknown> = valid();
    if (kind === "foreign") data.ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    if (kind === "expired") data.expiresAt = new Date(Date.now() - 1).toISOString();
    if (kind === "long-lived") data.expiresAt = new Date(Date.now() + 120_000).toISOString();
    if (kind === "malformed") data.token = "short";
    if (kind === "extra") data.ownerPassword = "inert-unexpected-secret";
    await expect(issueSharedAccountRequest(auth(data).context, "home", "lookup", [owner])).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("aborted and refused requests cannot reach fixed privileged gateways", async () => {
    const { context, rpc } = auth(valid()), abort = new AbortController(); abort.abort();
    await expect(issueSharedAccountRequest(context, "identity", "identity", [owner, {}, false], abort.signal)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(rpc).not.toHaveBeenCalled();
    await expect(issueSharedAccountRequest(auth(valid(), { message: "inert provider refusal" }).context, "home", "lookup", [owner])).rejects.toMatchObject({ code: "integration_unavailable" });
  });
});
