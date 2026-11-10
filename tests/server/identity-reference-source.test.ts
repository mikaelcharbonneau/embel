import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedContext } from "../../src/server/auth/context";
vi.mock("server-only", () => ({}));
import { defaultReferenceSource } from "../../src/server/identity/reference-source";
import { identityReferenceQuerySchema, referenceSourceResultSchema } from "../../src/domain/identity-references";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("default identity reference source", () => {
  it("always reports the missing source with no feed, network or database read", async () => {
    const fetch = vi.fn(() => {
      throw new Error("Default source must never fetch");
    });
    vi.stubGlobal("fetch", fetch);
    const client = new Proxy(
      {},
      {
        get() {
          throw new Error("Default source must never access an account database");
        },
      },
    );
    const auth = { userId: ownerId, client } as unknown as AuthenticatedContext;
    const result = await defaultReferenceSource.list(auth, projectId, identityReferenceQuerySchema.parse({}));
    expect(referenceSourceResultSchema.parse(result)).toEqual({
      status: "unavailable",
      reason: "reference_source_unconfigured",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not select a source or fetch from arbitrary tag values", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const auth = { userId: ownerId, client: {} } as AuthenticatedContext;
    const result = await defaultReferenceSource.list(
      auth,
      projectId,
      identityReferenceQuerySchema.parse({ excludedTags: ["https://example.invalid/private-feed"] }),
    );
    expect(result).toEqual({ status: "unavailable", reason: "reference_source_unconfigured" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
