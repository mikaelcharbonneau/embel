import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
  source: vi.fn(),
}));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("../../src/server/identity/reference-source", () => ({ defaultReferenceSource: { list: mocks.source } }));
import { GET } from "../../src/app/api/projects/[projectId]/identity/references/route";
import { PATCH } from "../../src/app/api/projects/[projectId]/identity/references/[referenceId]/route";
import { ApiError } from "../../src/server/http/errors";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  referenceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const anotherId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  time = "2026-10-04T00:00:00Z";
const params = { params: Promise.resolve({ projectId, referenceId }) };
const input = { expectedRevision: 0, ensemble: false, elements: ["colors", "logo"] };
function entry() {
  return {
    reference: {
      id: referenceId,
      ownerId,
      projectId,
      createdAt: time,
      media: {
        assetId: referenceId,
        versionId: anotherId,
        ownerId,
        projectId,
        contentHash: "a".repeat(64),
        purpose: "reference_media",
        mimeType: "image/png",
      },
      source: "user_supplied",
      attribution: { label: "Explicit synthetic reference", creator: null, sourceUrl: null, rightsNote: null },
      relevantElements: ["logo", "colors"],
      tags: ["local-tag"],
    },
    reaction: {
      referenceId,
      ownerId,
      projectId,
      revision: 1,
      ensemble: false,
      elements: ["logo", "colors"],
      updatedAt: time,
    },
  };
}
function overview() {
  return {
    ownerId,
    projectId,
    query: { limit: 40, excludedTags: [] },
    referenceRevision: 1,
    selectedReferenceCount: 1,
    feed: { status: "unavailable", reason: "reference_source_unconfigured" },
    availableTags: ["local-tag"],
    tagsComplete: true,
    references: { items: [entry()], nextCursor: null },
  };
}
function receipt() {
  return { ownerId, projectId, referenceRevision: 1, selectedReferenceCount: 1, entry: entry() };
}
function request(body?: unknown, query = "", headers: Record<string, string> = {}) {
  return new Request(`https://fluid.example/api/projects/${projectId}/identity/references${query}`, {
    method: body === undefined ? "GET" : "PATCH",
    headers: { origin: "https://fluid.example", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", "https://fluid.example");
  const chain = { select: mocks.select, eq: mocks.eq, maybeSingle: mocks.maybeSingle };
  mocks.from.mockReturnValue(chain);
  mocks.select.mockReturnValue(chain);
  mocks.eq.mockReturnValue(chain);
  mocks.maybeSingle.mockResolvedValue({ data: { id: projectId, owner_id: ownerId }, error: null });
  mocks.auth.mockResolvedValue({ userId: ownerId, client: { from: mocks.from, rpc: mocks.rpc } });
  mocks.rpc.mockResolvedValue({ data: overview(), error: null });
  mocks.source.mockResolvedValue({ status: "unavailable", reason: "reference_source_unconfigured" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("private reference read boundary", () => {
  it("authorizes the project before reading the source and preserves stored references with an unavailable feed", async () => {
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(overview());
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("projects");
    expect(mocks.eq).toHaveBeenCalledWith("owner_id", ownerId);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("get_identity_references", {
      p_project_id: projectId,
      p_query: { limit: 40, excludedTags: [] },
    });
    expect(mocks.maybeSingle.mock.invocationCallOrder[0]).toBeLessThan(mocks.source.mock.invocationCallOrder[0]!);
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.source.mock.invocationCallOrder[0]!);
  });
  it.each([null, { id: anotherId, owner_id: ownerId }, { id: projectId, owner_id: anotherId }])(
    "never consults the source or RPC for an inaccessible project %j",
    async (data) => {
      mocks.maybeSingle.mockResolvedValue({ data, error: null });
      expect((await GET(request(), params)).status).toBe(404);
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.source).not.toHaveBeenCalled();
    },
  );
  it("stops on an ownership read failure before source access", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "private failure" } });
    expect((await GET(request(), params)).status).toBe(503);
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires authentication and a valid project even while the feed is unconfigured", async () => {
    mocks.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));
    expect((await GET(request(), params)).status).toBe(401);
    expect((await GET(request(), { params: Promise.resolve({ projectId: "bad" }) })).status).toBe(404);
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    "?ownerId=" + ownerId,
    "?limit=1&limit=2",
    "?limit=101",
    "?limit=1.1",
    "?limit=+1",
    "?excludedTag=x&excludedTag=x",
    "?cursor=%7B",
    "?cursor=null",
    "?cursor={}&cursor={}",
    "?x=" + "a".repeat(32769),
  ])("rejects malformed, injected or excessive query %s", async (query) => {
    expect((await GET(request(undefined, query), params)).status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("preserves a canonical project/filter-bound cursor and repeated tag filters", async () => {
    const cursor = { projectId, referenceId, createdAt: time, excludedTags: ["z", "a"] };
    const query = { limit: 10, cursor: { ...cursor, excludedTags: ["a", "z"] }, excludedTags: ["a", "z"] };
    mocks.rpc.mockResolvedValue({
      data: { ...overview(), query, availableTags: ["a", "local-tag", "z"], tagsComplete: false },
      error: null,
    });
    const response = await GET(
      request(undefined, "?limit=10&excludedTag=z&excludedTag=a&cursor=" + encodeURIComponent(JSON.stringify(cursor))),
      params,
    );
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("get_identity_references", { p_project_id: projectId, p_query: query });
    expect(
      (
        await GET(
          request(
            undefined,
            "?cursor=" + encodeURIComponent(JSON.stringify({ ...cursor, projectId: anotherId, excludedTags: [] })),
          ),
          params,
        )
      ).status,
    ).toBe(422);
  });
  it.each([{ ownerId: anotherId }, { projectId: anotherId }])("hides a wrong response scope %j", async (patch) => {
    mocks.rpc.mockResolvedValue({
      data: { ...overview(), ...patch, references: { items: [], nextCursor: null } },
      error: null,
    });
    expect((await GET(request(), params)).status).toBe(404);
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it.each(["query", "nestedOwner", "media", "tags", "complete", "count", "feed"])(
    "fails closed on malformed stored %s",
    async (kind) => {
      const value = overview();
      if (kind === "query") value.query.limit = 2;
      if (kind === "nestedOwner") value.references.items[0]!.reaction.ownerId = anotherId;
      if (kind === "media") value.references.items[0]!.reference.media.projectId = anotherId;
      if (kind === "tags") value.availableTags = [];
      if (kind === "complete") Object.assign(value, { tagsComplete: undefined });
      if (kind === "count") value.selectedReferenceCount = 0;
      if (kind === "feed") Object.assign(value.feed, { privateToken: "never expose" });
      mocks.rpc.mockResolvedValue({ data: value, error: null });
      expect((await GET(request(), params)).status).toBe(503);
      expect(mocks.source).not.toHaveBeenCalled();
    },
  );
  it("validates an available source's scope/query but never ingests its rows", async () => {
    mocks.source.mockResolvedValue({
      status: "available",
      ownerId,
      projectId,
      query: overview().query,
      availableTags: [],
      tagsComplete: true,
      references: { items: [], nextCursor: null },
    });
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...overview(), feed: { status: "available" } });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    mocks.source.mockResolvedValue({
      status: "available",
      ownerId: anotherId,
      projectId,
      query: overview().query,
      availableTags: [],
      tagsComplete: true,
      references: { items: [], nextCursor: null },
    });
    expect((await GET(request(), params)).status).toBe(404);
  });
  it.each([
    ["P0002", 404],
    ["PGRST116", 404],
    ["PT409", 409],
    ["23505", 409],
    ["40001", 409],
    ["22023", 422],
    ["23514", 422],
    ["22003", 422],
    ["08006", 503],
    ["55000", 503],
  ] as const)("maps %s safely to %i", async (code, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "private row detail" } });
    const response = await GET(request(), params);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private row detail");
    expect(mocks.source).not.toHaveBeenCalled();
  });
});

describe("strict reference CAS route", () => {
  it("writes only the canonical explicit reaction and returns a neutral exact receipt", async () => {
    mocks.rpc.mockResolvedValue({ data: receipt(), error: null });
    const response = await PATCH(request(input), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt());
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("set_identity_reference_reaction", {
      p_project_id: projectId,
      p_reference_id: referenceId,
      p_input: { ...input, elements: ["logo", "colors"] },
    });
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("rejects malformed route identifiers before a mutation RPC", async () => {
    expect((await PATCH(request(input), { params: Promise.resolve({ projectId, referenceId: "bad" }) })).status).toBe(
      404,
    );
    expect((await PATCH(request(input), { params: Promise.resolve({ projectId: "bad", referenceId }) })).status).toBe(
      404,
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("checks origin before authentication and rejects unauthenticated writes", async () => {
    expect((await PATCH(request(input, "", { origin: "https://foreign.example" }), params)).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    mocks.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));
    expect((await PATCH(request(input), params)).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["ownerId", "projectId", "referenceId", "media", "provider", "source", "used", "revision"])(
    "rejects injected %s before RPC",
    async (key) => {
      expect((await PATCH(request({ ...input, [key]: anotherId }), params)).status).toBe(422);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it.each(["referenceId", "revision", "ensemble", "elements", "count", "aggregate"])(
    "rejects a mismatched accepted mutation %s",
    async (kind) => {
      const value = receipt();
      if (kind === "referenceId") {
        value.entry.reference.id = anotherId;
        value.entry.reaction.referenceId = anotherId;
      }
      if (kind === "revision") {
        value.entry.reaction.revision = 2;
        value.referenceRevision = 2;
      }
      if (kind === "ensemble") value.entry.reaction.ensemble = true;
      if (kind === "elements") value.entry.reaction.elements = [];
      if (kind === "count") value.selectedReferenceCount = 0;
      if (kind === "aggregate") value.referenceRevision = 0;
      mocks.rpc.mockResolvedValue({ data: value, error: null });
      expect((await PATCH(request(input), params)).status).toBe(503);
    },
  );
  it("bounds streamed UTF-8 bytes independently of a false Content-Length", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...input, extra: "é".repeat(17000) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const req = new Request("https://fluid.example/api/references", {
      method: "PATCH",
      headers: { origin: "https://fluid.example", "content-type": "application/json", "content-length": "1" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await PATCH(req, params)).status).toBe(413);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
