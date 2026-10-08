import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const verify = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/data/project-naming", () => ({ getVerifiedProjectName: verify }));
import { getStandaloneWorkspace, saveStandaloneWorkspace, getStandaloneImport } from "../../src/server/data/standalone-workspaces";
import type { AuthenticatedContext } from "../../src/server/auth/context";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", key = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const payload = { version: 1, input: "Cedar", extensions: ["com"], candidates: [] };
const workspace = () => ({ id, ownerId: owner, tool: "domains", revision: 1, payload, imports: [], createdAt: "2026-10-06T00:00:00.000123Z", updatedAt: "2026-10-06T00:00:00.000123Z" });
const response = () => ({ ownerId: owner, workspace: workspace() });
const source = () => ({ projectId: id, projectRevision: 2, projectTitle: "Local fixture", name: "Cedar", selectionId: key, candidateId: id, origin: "naming_selection" });
const input = () => ({ requestKey: key, expectedRevision: 0, payload, imports: [] });
function fixture(values: unknown[], code?: string) {
  const calls: { name: string; args: unknown }[] = [];
  const auth = { userId: owner, client: { rpc: (name: string, args: unknown) => { calls.push({ name, args }); return { then: (resolve: (r: unknown) => void) => Promise.resolve({ data: values.shift(), error: code ? { code, message: "PRIVATE DATABASE FAILURE" } : null }).then(resolve) }; } } } as unknown as AuthenticatedContext;
  return { auth, calls };
}
describe("standalone server ownership, strict registry and immutable imports", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(() => { verify.mockReset(); verify.mockResolvedValue({ ownerId: owner, projectId: id, id, value: "Cedar", contextRevision: 1 }); });
  it("uses PromiseLike RPC transport, derives owner only from verified auth and normalizes UUID request keys", async () => {
    const f = fixture([{ ownerId: owner, workspace: null }, response()]);
    expect(await saveStandaloneWorkspace(f.auth, "domains", { ...input(), requestKey: key.toUpperCase() })).toEqual(response());
    expect(f.calls).toEqual([{ name: "get_standalone_workspace", args: { p_tool: "domains" } }, { name: "save_standalone_workspace", args: { p_tool: "domains", p_expected_revision: 0, p_request_key: key, p_payload: payload, p_imports: [] } }]);
  });
  it("keeps no-name import distinct from an unavailable project", async () => {
    const f = fixture([{ ownerId: owner, projectId: id, source: null }]);
    expect(await getStandaloneImport(f.auth, id)).toEqual({ ownerId: owner, source: null }); expect(verify).not.toHaveBeenCalled();
  });
  it("replays candidate provenance on import, saves and later workspace reads", async () => {
    const result = { ...response(), workspace: { ...workspace(), imports: [source()] } };
    const f = fixture([{ ownerId: owner, workspace: null }, { ownerId: owner, projectId: id, source: source() }, result, result]);
    const imports = [{ projectId: id, projectRevision: 2, selectionId: key }];
    expect(await saveStandaloneWorkspace(f.auth, "domains", { ...input(), imports })).toEqual(result);
    expect(await getStandaloneWorkspace(f.auth, "domains")).toEqual(result); expect(verify).toHaveBeenCalledTimes(3);
  });
  it("reuses prior immutable sources on exact-key retry even when a current project head would differ", async () => {
    const result = { ...response(), workspace: { ...workspace(), imports: [source()] } };
    const f = fixture([result, result]);
    expect(await saveStandaloneWorkspace(f.auth, "domains", { ...input(), imports: [{ projectId: id, projectRevision: 2, selectionId: key }] })).toEqual(result);
    expect(f.calls.map(call => call.name)).toEqual(["get_standalone_workspace", "save_standalone_workspace"]);
  });
  it.each([null, { ...response(), ownerId: foreign }, { ...response(), workspace: { ...workspace(), ownerId: foreign } }, { ...response(), workspace: { ...workspace(), tool: "handles" } },
    { ...response(), workspace: { ...workspace(), payload: { ...payload, availability: "available" } } }])("fails closed on malformed or cross-owner read DTO", async bad => {
    await expect(getStandaloneWorkspace(fixture([bad]).auth, "domains")).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it.each([{ ...input(), ownerId: foreign }, { ...input(), payload: { ...payload, checks: [] } }, { ...input(), payload: undefined }, { ...input(), imports: [{ projectId: id, projectRevision: 1, selectionId: null, name: "Forgery" }] },
    { ...input(), expectedRevision: -1 }, { ...input(), expectedRevision: 2147483647 }])("rejects forged or malformed mutations before any read/write", async bad => {
    const f = fixture([]); await expect(saveStandaloneWorkspace(f.auth, "domains", bad)).rejects.toMatchObject({ code: "invalid_input" }); expect(f.calls).toEqual([]);
  });
  it("rejects inconsistent mutation responses and preserves generic error privacy", async () => {
    const f = fixture([{ ownerId: owner, workspace: null }, { ...response(), workspace: { ...workspace(), revision: 4 } }]);
    await expect(saveStandaloneWorkspace(f.auth, "domains", input())).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("rejects foreign or mismatched immutable candidates despite syntactically valid source DTO", async () => {
    for (const candidate of [{ ownerId: foreign, projectId: id, id, value: "Cedar", contextRevision: 1 }, { ownerId: owner, projectId: id, id, value: "Other", contextRevision: 1 }, { ownerId: owner, projectId: id, id, value: "Cedar", contextRevision: 9 }]) {
      verify.mockResolvedValueOnce(candidate);
      await expect(getStandaloneImport(fixture([{ ownerId: owner, projectId: id, source: source() }]).auth, id)).rejects.toMatchObject({ code: "integration_unavailable" });
    }
    verify.mockRejectedValueOnce(new Error("forged transform history"));
    await expect(getStandaloneImport(fixture([{ ownerId: owner, projectId: id, source: source() }]).auth, id)).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("rejects changed import heads before attempting mutation", async () => {
    const f = fixture([{ ownerId: owner, workspace: null }, { ownerId: owner, projectId: id, source: source() }]);
    await expect(saveStandaloneWorkspace(f.auth, "domains", { ...input(), imports: [{ projectId: id, projectRevision: 1, selectionId: key }] })).rejects.toMatchObject({ code: "conflict" });
    expect(f.calls.map(call => call.name)).toEqual(["get_standalone_workspace", "get_standalone_import"]);
  });
  it.each(["42P01", "42883", "PGRST202", "XX000"])("reports honest unavailable when schema/transport is absent (%s)", async code => {
    await expect(getStandaloneWorkspace(fixture([], code).auth, "domains")).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it.each([["42501", "unauthenticated"], ["40001", "conflict"], ["23505", "conflict"], ["22023", "invalid_input"], ["P0002", "not_found"]])("maps database %s safely", async (code, expected) => {
    await expect(getStandaloneWorkspace(fixture([], code).auth, "domains")).rejects.toMatchObject({ code: expected });
  });
  it("does not contact SQL for unsupported tools or malformed project IDs", async () => {
    const f = fixture([]); await expect(getStandaloneWorkspace(f.auth, "orders")).rejects.toMatchObject({ code: "not_found" });
    await expect(getStandaloneImport(f.auth, "bad")).rejects.toMatchObject({ code: "not_found" }); expect(f.calls).toEqual([]);
  });
});

describe("standalone local failure diagnostics", () => {
  beforeEach(() => { vi.stubEnv("FLUID_RUNTIME", "local"); vi.stubEnv("VERCEL", ""); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const context = (rpc: unknown) => ({ userId: owner, client: { rpc } }) as AuthenticatedContext;
  it.each([
    { code: "", status: 0, codeType: "string", safeCode: "unrecognized", safeStatus: 0 },
    { code: undefined, status: 500, codeType: "undefined", safeCode: "unrecognized", safeStatus: 500 },
    { code: null, status: 503, codeType: "null", safeCode: "unrecognized", safeStatus: 503 },
    { code: 40001, status: 500, codeType: "number", safeCode: "unrecognized", safeStatus: 500 },
    { code: "PGRST000", status: 503, codeType: "string", safeCode: "PGRST000", safeStatus: 503 },
    { code: "private-code", status: "private-status", codeType: "string", safeCode: "unrecognized", safeStatus: null },
    { code: { toString: () => { throw new Error("never stringify private values"); } }, status: NaN, codeType: "object", safeCode: "unrecognized", safeStatus: null },
  ])("classifies unavailable read RPC using only bounded values: $codeType/$safeStatus", async sample => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = context(vi.fn().mockResolvedValue({ data: "private-body", error: { code: sample.code, message: "private-message", details: "private-details" }, status: sample.status }));
    await expect(getStandaloneWorkspace(auth, "domains")).rejects.toMatchObject({ code: "integration_unavailable", status: 503 });
    expect(warn).toHaveBeenCalledExactlyOnceWith("[fluid:standalone]", {
      stage: "workspace_read_rpc", codeType: sample.codeType, code: sample.safeCode, status: sample.safeStatus,
    });
  });
  it("never invokes getters for an RPC error code, status or private message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getter = vi.fn(() => { throw new Error("private-getter-value"); });
    const error = Object.defineProperties({}, { code: { get: getter }, message: { get: getter }, details: { get: getter } });
    const result = Object.defineProperty({ data: null, error }, "status", { get: getter });
    await expect(getStandaloneWorkspace(context(vi.fn().mockResolvedValue(result)), "domains")).rejects.toMatchObject({ code: "integration_unavailable", status: 503 });
    expect(getter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith("[fluid:standalone]", { stage: "workspace_read_rpc", codeType: "undefined", code: "unrecognized", status: null });
  });
  it("contains hostile proxy descriptors and rejected error getters without interpreting them as conflicts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("private-descriptor-value"); } });
    await expect(getStandaloneWorkspace(context(vi.fn().mockResolvedValue({ error: proxy, data: null })), "domains")).rejects.toMatchObject({ code: "integration_unavailable" });
    const getter = vi.fn(() => { throw new Error("private-rejection-value"); });
    await expect(getStandaloneWorkspace(context(vi.fn().mockRejectedValue(Object.defineProperty({}, "code", { get: getter }))), "domains")).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(getter).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual(Array.from({ length: 2 }, () => ["[fluid:standalone]", { stage: "workspace_read_rpc", codeType: "undefined", code: "unrecognized", status: null }]));
  });
  it("distinguishes a rejected save transport from a rejected pre-save read without logging its message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValueOnce({ data: response(), error: null }).mockRejectedValueOnce(new TypeError("private-response-lost-after-commit"));
    await expect(saveStandaloneWorkspace(context(rpc), "domains", { ...input(), expectedRevision: 1 })).rejects.toMatchObject({ code: "integration_unavailable", status: 503 });
    expect(warn).toHaveBeenCalledExactlyOnceWith("[fluid:standalone]", { stage: "save_rpc", codeType: "undefined", code: "unrecognized", status: null });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it.each([
    { stage: "workspace_read_response", values: [null] },
    { stage: "workspace_read_binding", values: [{ ownerId: foreign, workspace: null }] },
    { stage: "save_response", values: [{ ownerId: owner, workspace: null }, null] },
    { stage: "save_binding", values: [{ ownerId: owner, workspace: null }, { ...response(), workspace: { ...workspace(), revision: 4 } }] },
  ])("identifies $stage without returning private response values", async ({ stage, values }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(saveStandaloneWorkspace(fixture(values).auth, "domains", input())).rejects.toMatchObject({ code: "integration_unavailable", status: 503 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[fluid:standalone]", stage.endsWith("response") ? { stage, issueCodes: ["invalid_type"] } : { stage });
  });
  it("identifies frozen source verification failure before any save RPC", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    verify.mockRejectedValueOnce(new Error("private-candidate-data"));
    const f = fixture([{ ...response(), workspace: { ...workspace(), imports: [source()] } }]);
    await expect(saveStandaloneWorkspace(f.auth, "domains", input())).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(warn).toHaveBeenCalledExactlyOnceWith("[fluid:standalone]", { stage: "workspace_source" });
    expect(f.calls.map(call => call.name)).toEqual(["get_standalone_workspace"]);
  });
  it.each([{ runtime: "", vercel: "" }, { runtime: "local", vercel: "1" }])("suppresses diagnostics outside local execution: $runtime/$vercel", async env => {
    vi.stubEnv("FLUID_RUNTIME", env.runtime); vi.stubEnv("VERCEL", env.vercel);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(getStandaloneWorkspace(fixture([], "PGRST000").auth, "domains")).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(warn).not.toHaveBeenCalled();
  });
});
