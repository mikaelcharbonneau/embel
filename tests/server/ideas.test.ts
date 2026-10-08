import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createIdea, createIdeaBrand, getIdea, getProjectIdeaSource, listIdeas, updateIdea } from "../../src/server/data/ideas";
import { ideaContentSchema, ideaProjectInput } from "../../src/domain/ideas";
import type { AuthenticatedContext } from "../../src/server/auth/context";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", projectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", key = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const createdAt = "2026-10-05T12:00:00.000002Z";
const content = () => ideaContentSchema.parse({ title: "Local fixture", description: " Original ", details: { solution: " Product ", audience: " People " } });
const record = (revision = 1) => ({ id, ownerId: owner, revision, content: content(), createdAt, updatedAt: createdAt, links: [] as unknown[] });
const link = () => ({ id: key, ownerId: owner, ideaId: id, ideaRevision: 1, projectId, requestKey: key, createdAt });
const summary = () => ({ id, ownerId: owner, revision: 1, title: content().title, description: content().description,
  theme: content().theme, state: content().state, createdAt, updatedAt: createdAt });
function fixture(responses: unknown[], code?: string) {
  const calls: { name: string; input: unknown }[] = [];
  const auth = { userId: owner, client: { rpc: async (name: string, input: unknown) => { calls.push({ name, input }); return { data: responses.shift(), error: code ? { code, message: "PRIVATE DATABASE DETAILS" } : null }; } } } as unknown as AuthenticatedContext;
  return { auth, calls };
}
describe("manual Ideas data boundary (synthetic RPC transport)", () => {
  it("accepts the installed Supabase PromiseLike-only RPC transport without a catch member", async () => {
    const auth = { userId: owner, client: { rpc: () => ({ then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: record(), error: null }).then(resolve); } }) } } as unknown as AuthenticatedContext;
    expect(await getIdea(auth, id)).toEqual(record());
  });
  it("maps a rejected RPC transport to an unavailable integration", async () => {
    const auth = { userId: owner, client: { rpc: () => Promise.reject(new Error("PRIVATE TRANSPORT DETAILS")) } } as unknown as AuthenticatedContext;
    await expect(getIdea(auth, id)).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("derives identity exclusively from verified context and parses normalized content", async () => {
    const f = fixture([record()]);
    expect(await createIdea(f.auth, { requestKey: key, content: { title: "  Local fixture  " } })).toEqual(record());
    expect(f.calls).toEqual([{ name: "create_idea", input: { p_request_key: key, p_content: ideaContentSchema.parse({ title: "Local fixture" }) } }]);
  });
  it("reads and updates only the bound owned idea", async () => {
    const changed = { ...record(2), content: ideaContentSchema.parse({ title: "Changed" }) }, f = fixture([record(), changed]);
    expect(await getIdea(f.auth, id)).toEqual(record());
    expect(await updateIdea(f.auth, id, { expectedRevision: 1, requestKey: key, content: { title: "Changed" } })).toEqual(changed);
    expect(f.calls[1]).toEqual({ name: "update_idea", input: { p_idea_id: id, p_expected_revision: 1, p_request_key: key, p_content: changed.content } });
  });
  it("keeps full-library search and exact cursor as bound RPC values", async () => {
    const row = summary(); const f = fixture([{ ownerId: owner, items: [row], nextCursor: null }]);
    const cursor = { createdAt: "2026-10-05T12:00:00.000003Z", id };
    expect((await listIdeas(f.auth, { search: "  %_';drop  ", state: "to_explore", limit: 7, cursor })).items).toHaveLength(1);
    expect(f.calls).toEqual([{ name: "list_ideas", input: { p_cursor_created_at: cursor.createdAt, p_cursor_id: id, p_limit: 7, p_search: "%_';drop", p_state: "to_explore" } }]);
  });
  it("loads owned source and derives the complete unreviewed context/hash on the server", async () => {
    const promoted = { idea: { ...record(2), content: { ...content(), state: "used" }, links: [link()] }, link: link() }, f = fixture([record(), promoted]);
    expect(await createIdeaBrand(f.auth, id, { expectedRevision: 1, requestKey: key })).toEqual(promoted);
    const normalized = ideaProjectInput(content()).context;
    expect(f.calls[1]).toEqual({ name: "create_idea_brand", input: { p_idea_id: id, p_expected_revision: 1, p_request_key: key, p_context: normalized,
      p_input_hash: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") } });
  });
  it("replays conversion from immutable source after a subsequent edit instead of remapping current content", async () => {
    const later = { ...record(3), content: ideaContentSchema.parse({ title: "Later edit" }), links: [link()] };
    const f = fixture([later, { ownerId: owner, projectId, source: { link: link(), content: content() } }, { idea: later, link: link() }]);
    expect(await createIdeaBrand(f.auth, id, { expectedRevision: 1, requestKey: key })).toEqual({ idea: later, link: link() });
    expect(f.calls.map(call => call.name)).toEqual(["get_idea", "get_project_idea_source", "create_idea_brand"]);
    expect(f.calls[2]?.input).toMatchObject({ p_context: ideaProjectInput(content()).context });
  });
  it("returns a truthful absent source for an owned project", async () => {
    const f = fixture([{ ownerId: owner, projectId, source: null }]);
    expect(await getProjectIdeaSource(f.auth, projectId)).toEqual({ ownerId: owner, projectId, source: null });
  });
  it.each([null, { ...record(), ownerId: foreign }, { ...record(), id: projectId }, { ...record(), content: { title: "" } }])("fails closed on missing/foreign/malformed record", async data => {
    await expect(getIdea(fixture([data]).auth, id)).rejects.toMatchObject({ code: data === null ? "not_found" : "integration_unavailable" });
  });
  it.each(["bad", ""]) ("rejects invalid resource identifiers before reads", async badId => {
    const f = fixture([]); await expect(getIdea(f.auth, badId)).rejects.toMatchObject({ code: "not_found" }); expect(f.calls).toEqual([]);
  });
  it.each([{ requestKey: key, content: { title: "x" }, ownerId: foreign }, { requestKey: key, content: { title: "x", ownerId: foreign } }, { requestKey: "bad", content: { title: "x" } }])("rejects forged creation inputs before RPC", async input => {
    const f = fixture([]); await expect(createIdea(f.auth, input)).rejects.toMatchObject({ code: "invalid_input" }); expect(f.calls).toEqual([]);
  });
  it("bounds actual serialized UTF-8 mutation size and SQL revision integer ranges", async () => {
    const f = fixture([]); await expect(createIdea(f.auth, { requestKey: key, content: { title: "x", description: "🙂".repeat(6000), details: { problem: "🙂".repeat(1000), notes: "🙂".repeat(1000), solution: "🙂".repeat(1000) } } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(updateIdea(f.auth, id, { requestKey: key, expectedRevision: Number.MAX_SAFE_INTEGER, content: { title: "x" } })).rejects.toMatchObject({ code: "invalid_input" }); expect(f.calls).toEqual([]);
  });
  it.each([{ ownerId: foreign, items: [], nextCursor: null }, { ownerId: owner, items: [], nextCursor: { id, createdAt } }])("rejects foreign or inconsistent page metadata", async page => {
    await expect(listIdeas(fixture([page]).auth, {})).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("rejects a non-progressing page and rows exceeding the requested bound", async () => {
    const row = summary();
    await expect(listIdeas(fixture([{ ownerId: owner, items: [row], nextCursor: null }]).auth, { cursor: { id, createdAt } })).rejects.toMatchObject({ code: "integration_unavailable" });
    const row2 = { ...row, id: projectId };
    await expect(listIdeas(fixture([{ ownerId: owner, items: [row2, row], nextCursor: null }]).auth, { limit: 1 })).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("rejects a changed update response and a disconnected promotion link", async () => {
    await expect(updateIdea(fixture([record(2)]).auth, id, { requestKey: key, expectedRevision: 1, content: { title: "Changed" } })).rejects.toMatchObject({ code: "integration_unavailable" });
    await expect(createIdeaBrand(fixture([record(), { idea: record(2), link: link() }]).auth, id, { requestKey: key, expectedRevision: 1 })).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("rejects foreign project source and replay metadata", async () => {
    await expect(getProjectIdeaSource(fixture([{ ownerId: foreign, projectId, source: null }]).auth, projectId)).rejects.toMatchObject({ code: "integration_unavailable" });
    await expect(createIdeaBrand(fixture([{ ...record(2), links: [link()] }, { ownerId: owner, projectId, source: { link: { ...link(), ideaId: projectId }, content: content() } }]).auth, id, { requestKey: key, expectedRevision: 1 })).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it.each([{ code: "P0002", result: "not_found" }, { code: "40001", result: "conflict" }, { code: "23505", result: "conflict" }, { code: "22023", result: "invalid_input" },
    { code: "42501", result: "unauthenticated" }, { code: "XX000", result: "integration_unavailable" }])("maps database $code without exposing internals", async ({ code, result }) => {
    await expect(getIdea(fixture([null], code).auth, id)).rejects.toMatchObject({ code: result });
  });
});
