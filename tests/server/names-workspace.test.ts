import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getNamesWorkspace, saveNamesWorkspace } from "../../src/server/data/names-workspace";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { MAX_NAMES_BYTES, namesWorkspaceSchema } from "../../src/domain/names-workspace";
import { namesFixtureId as id, namesFixtureTime as time, namesWorkspaceFixture } from "../fixtures/names-workspace";

const owner = id(900), foreign = id(901);
const input = () => ({ requestKey: id(999), expectedRevision: 0, payload: namesWorkspaceFixture() });
const response = () => ({ ownerId: owner, workspace: { id: id(800), ownerId: owner, revision: 1,
  payload: namesWorkspaceFixture(), createdAt: time, updatedAt: time } });
function fixture(value: unknown, error: unknown = null) {
  const rpc = vi.fn(() => ({ then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: value, error }).then(resolve) }));
  const auth = { userId: owner, client: { rpc } } as unknown as AuthenticatedContext;
  return { auth, rpc };
}
describe("account Names workspace validation and response binding", () => {
  it("persists the entire compatible V1 graph without a pre-save read and normalizes only the request key", async () => {
    const f = fixture(response());
    expect(await saveNamesWorkspace(f.auth, { ...input(), requestKey: id(999).toUpperCase() })).toEqual(response());
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith("save_names_workspace", {
      p_expected_revision: 0, p_request_key: id(999), p_payload: namesWorkspaceFixture(),
    });
    expect(namesWorkspaceSchema.safeParse(response().workspace.payload).success).toBe(true);
  });
  it("distinguishes no saved workspace from unavailable persistence", async () => {
    const f = fixture({ ownerId: owner, workspace: null });
    expect(await getNamesWorkspace(f.auth)).toEqual({ ownerId: owner, workspace: null });
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith("get_names_workspace", {});
  });
  it.each([
    (p: ReturnType<typeof namesWorkspaceFixture>) => { p.candidates[1]!.source.value = "Forged"; },
    (p: ReturnType<typeof namesWorkspaceFixture>) => { p.candidates[1]!.explanation = "Unproved explanation"; },
    (p: ReturnType<typeof namesWorkspaceFixture>) => { p.runs[0]!.notes.push("Invented note"); },
    (p: ReturnType<typeof namesWorkspaceFixture>) => { p.runs[0]!.candidateIds = []; },
    (p: ReturnType<typeof namesWorkspaceFixture>) => { p.candidates[2]!.source.history[0]!.input = { kind: "tweaks", seed: "Cedar", operations: ["uppercase"] }; },
    (p: ReturnType<typeof namesWorkspaceFixture>) => { p.ui.comparisonIds = [id(700)]; },
    (p: ReturnType<typeof namesWorkspaceFixture>) => { p.ui.guided!.savedLists[0]!.words[0]!.value = "Changed source"; },
  ])("replays deterministic results and references before RPC and again when reading stored data", async mutate => {
    const payload = namesWorkspaceFixture(); mutate(payload);
    const f = fixture({ ...response(), workspace: { ...response().workspace, payload } });
    await expect(saveNamesWorkspace(f.auth, { ...input(), payload })).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.rpc).not.toHaveBeenCalled();
    await expect(getNamesWorkspace(f.auth)).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it.each([
    { ...input(), ownerId: foreign }, { ...input(), requestKey: "bad" }, { ...input(), expectedRevision: -1 },
    { ...input(), expectedRevision: 2147483647 }, { ...input(), payload: { ...namesWorkspaceFixture(), providerOutput: "forged" } },
  ])("rejects unsupported mutation fields before touching SQL", async value => {
    const f = fixture(response());
    await expect(saveNamesWorkspace(f.auth, value)).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([
    null, { ...response(), ownerId: foreign }, { ...response(), workspace: { ...response().workspace, ownerId: foreign } },
    { ...response(), workspace: { ...response().workspace, payload: { ...namesWorkspaceFixture(), futureVersion: true } } },
  ])("never exposes a malformed or foreign account read", async value => {
    await expect(getNamesWorkspace(fixture(value).auth)).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it.each([
    { ownerId: owner, workspace: null }, { ...response(), workspace: { ...response().workspace, revision: 3 } },
    { ...response(), workspace: { ...response().workspace, payload: { ...namesWorkspaceFixture(), revision: 43 } } },
  ])("requires an exact mutation acknowledgement", async value => {
    await expect(saveNamesWorkspace(fixture(value).auth, input())).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("enforces the complete 4 MB UTF-8 payload limit while retaining old format capacity", async () => {
    const payload = namesWorkspaceFixture();
    payload.candidates = Array.from({ length: 100 }, (_, index) => ({ ...payload.candidates[0]!,
      source: { ...payload.candidates[0]!.source, id: id(index + 1000) },
      context: { ...payload.candidates[0]!.context, description: "🙂".repeat(10_000) },
    }));
    payload.runs = []; payload.ui.comparisonIds = []; payload.ui.activeRunId = null; payload.ui.seedCandidateId = null; delete payload.ui.guided;
    expect(namesWorkspaceSchema.safeParse(payload).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(MAX_NAMES_BYTES);
    const f = fixture(response());
    await expect(saveNamesWorkspace(f.auth, { ...input(), payload })).rejects.toMatchObject({ code: "body_too_large" });
    expect(f.rpc).not.toHaveBeenCalled();
    await expect(getNamesWorkspace(fixture({ ...response(), workspace: { ...response().workspace, payload } }).auth)).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it.each([["42501", "unauthenticated"], ["PT409", "conflict"], ["40001", "conflict"], ["23505", "conflict"],
    ["22023", "invalid_input"], ["23514", "invalid_input"], ["54000", "body_too_large"], ["42883", "integration_unavailable"], ["PGRST202", "integration_unavailable"]])("maps SQL %s without exposing database details", async (code, expected) => {
    await expect(saveNamesWorkspace(fixture(null, { code, message: "PRIVATE DETAILS" }).auth, input())).rejects.toMatchObject({ code: expected });
  });
  it("contains rejected transports and hostile error getters as an unknown save outcome", async () => {
    const f = fixture(null); f.rpc.mockImplementationOnce(() => { throw new Error("PRIVATE TRANSPORT"); });
    await expect(saveNamesWorkspace(f.auth, input())).rejects.toMatchObject({ code: "integration_unavailable" });
    const getter = vi.fn(() => { throw new Error("PRIVATE GETTER"); });
    await expect(saveNamesWorkspace(fixture(null, Object.defineProperty({}, "code", { get: getter })).auth, input())).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(getter).not.toHaveBeenCalled();
  });
});
