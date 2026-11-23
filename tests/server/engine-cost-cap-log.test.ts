import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthenticatedContext } from "@/server/auth/context";
import { admitGeneration, logCostCapRefusal } from "@/server/engine/runs";
import { ApiError } from "@/server/http/errors";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const request = { kind: "naming.generate", idempotencyKey: "cost-cap-log-0001" };
const authWith = (error: Record<string, unknown>) =>
  ({ client: { rpc: async () => ({ data: null, error }) } }) as unknown as AuthenticatedContext;

afterEach(() => vi.restoreAllMocks());

// start_generation refuses with the message generation_paused both for the pause switch and for
// a reached cost cap; only its detail tells them apart (docs/emergency-stop.md).
describe("a start refused by a daily cost cap", () => {
  it("is logged with the cap that refused it, and still reads as an unavailable step", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const cap of ["cost_cap", "free_cost_cap"]) {
      const refusal = await admitGeneration(
        authWith({ message: "generation_paused", code: "55000", details: cap }),
        PROJECT,
        request,
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ApiError);
      expect((refusal as ApiError).code).toBe("generation_unavailable");
      const line = JSON.parse(String(logged.mock.calls.at(-1)![0])) as Record<string, unknown>;
      expect(line).toMatchObject({ event: "generation_cost_cap_reached", cap });
    }
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it("stays quiet for the pause switch and for every other refusal", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const error of [
      { message: "generation_paused", code: "55000", details: null },
      { message: "insufficient_credits", code: "PT402" },
      { message: "generation_paused", code: "55000", details: "something else" },
    ]) {
      await admitGeneration(authWith(error), PROJECT, request).catch(() => undefined);
    }
    logCostCapRefusal(null);
    logCostCapRefusal("cost_cap");
    expect(logged).not.toHaveBeenCalled();
  });
});
