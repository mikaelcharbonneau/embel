import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { expireOpenCheckouts } from "@/server/billing/sessions";
import type { StripeClient } from "@/server/billing/stripe";
import { ApiError } from "@/server/http/errors";

// Obvious fakes only: no Stripe key, no network.
function fakeStripe(open: string[], hasMore = false) {
  const sessions = {
    list: vi.fn(async () => ({ data: open.map((id) => ({ id })), has_more: hasMore })),
    expire: vi.fn(async (id: string) => ({ id, status: "expired" })),
    retrieve: vi.fn(async (id: string) => ({ id, status: "open" })),
  };
  return { sessions, client: { checkout: { sessions } } as unknown as StripeClient };
}
async function refusal(run: Promise<unknown>) {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).code;
}

describe("closing earlier Checkout pages", () => {
  it("asks Stripe for the customer's open pages only and expires each one", async () => {
    const { sessions, client } = fakeStripe(["cs_test_a", "cs_test_b"]);
    await expireOpenCheckouts(client, "cus_Existing");
    expect(sessions.list).toHaveBeenCalledWith({ customer: "cus_Existing", status: "open", limit: 100 });
    expect(sessions.expire.mock.calls.map(([id]) => id)).toEqual(["cs_test_a", "cs_test_b"]);
    expect(sessions.retrieve).not.toHaveBeenCalled();
  });

  it("does nothing when no page is open", async () => {
    const { sessions, client } = fakeStripe([]);
    await expireOpenCheckouts(client, "cus_Existing");
    expect(sessions.expire).not.toHaveBeenCalled();
  });

  it("accepts a page that expired by itself in the meantime and goes on to the next", async () => {
    const { sessions, client } = fakeStripe(["cs_test_a", "cs_test_b"]);
    sessions.expire.mockRejectedValueOnce(new Error("not open"));
    sessions.retrieve.mockResolvedValueOnce({ id: "cs_test_a", status: "expired" });
    await expireOpenCheckouts(client, "cus_Existing");
    expect(sessions.expire).toHaveBeenCalledTimes(2);
  });

  it("refuses with billing_pending when a page was paid in the meantime", async () => {
    const { sessions, client } = fakeStripe(["cs_test_a"]);
    sessions.expire.mockRejectedValueOnce(new Error("not open"));
    sessions.retrieve.mockResolvedValueOnce({ id: "cs_test_a", status: "complete" });
    expect(await refusal(expireOpenCheckouts(client, "cus_Existing"))).toBe("billing_pending");
  });

  it("refuses as unavailable when a page may still be open", async () => {
    // The list fails.
    let fake = fakeStripe([]);
    fake.sessions.list.mockRejectedValueOnce(new Error("network"));
    expect(await refusal(expireOpenCheckouts(fake.client, "cus_Existing"))).toBe("integration_unavailable");
    // Expiring fails and the page still reads as open.
    fake = fakeStripe(["cs_test_a"]);
    fake.sessions.expire.mockRejectedValueOnce(new Error("timeout"));
    expect(await refusal(expireOpenCheckouts(fake.client, "cus_Existing"))).toBe("integration_unavailable");
    // Expiring fails and the page cannot be read either.
    fake = fakeStripe(["cs_test_a"]);
    fake.sessions.expire.mockRejectedValueOnce(new Error("timeout"));
    fake.sessions.retrieve.mockRejectedValueOnce(new Error("timeout"));
    expect(await refusal(expireOpenCheckouts(fake.client, "cus_Existing"))).toBe("integration_unavailable");
    // More open pages than one listing returns: the listed ones are closed, the request is refused.
    fake = fakeStripe(["cs_test_a"], true);
    expect(await refusal(expireOpenCheckouts(fake.client, "cus_Existing"))).toBe("integration_unavailable");
    expect(fake.sessions.expire).toHaveBeenCalledTimes(1);
  });
});
