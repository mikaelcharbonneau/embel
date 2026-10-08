import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { accountProjectSchema } from "@/domain/project-api";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { accountRequest, AccountRequestError } from "@/components/workspace/account-api";
import { createNamingRequestScope, namingBatchIntentKey, namingDraftBlocked, namingErrorMessage, namingOwned, namingScrollTarget } from "@/components/naming/use-project-naming";
import { parseNamingPreferenceFields } from "@/components/naming/naming-preferences";
import { initialWorkshopControls, workshopControlsInput } from "@/components/naming/workshop-controls";

const ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const account = { status: "ready" as const, userId: ownerId, generation: 1 };
const responseSchema = z.strictObject({ ownerId: z.uuid(), projectId: z.uuid(), value: z.string() });
const response = { ownerId, projectId, value: "Private account name" };
const isOwned = (value: z.infer<typeof responseSchema>) => namingOwned(value, ownerId, projectId);

afterEach(() => vi.unstubAllGlobals());

describe("private naming request fence", () => {
  const operations = [
    ["overview", "GET"], ["candidate pagination", "GET"], ["batch history", "GET"], ["library", "GET"],
    ["preferences", "PATCH"], ["view", "PATCH"], ["retention", "PATCH"], ["selection", "POST"],
    ["generation", "POST"], ["transform", "POST"], ["import", "POST"], ["promotion", "POST"], ["expansion", "POST"], ["cancellation", "DELETE"],
  ] as const;
  it.each(operations)("discards %s when the account changes during a pending %s", async (_label, method) => {
    let current = true;
    let finish!: (response: Response) => void;
    const request = new Promise<Response>(resolve => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => request));
    const scope = createNamingRequestScope(account, () => current, vi.fn());
    const pending = scope.request("/api/private-fixture", responseSchema, isOwned, { method });
    current = false;
    finish(Response.json(response));
    await expect(pending).resolves.toBeNull();
  });
  it("rejects another owner or project before publishing even a valid response", async () => {
    for (const patch of [{ ownerId: projectId }, { projectId: ownerId }]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...response, ...patch })));
      const expire = vi.fn();
      const scope = createNamingRequestScope(account, () => true, expire);
      await expect(scope.request("/api/private-fixture", responseSchema, isOwned)).resolves.toBeNull();
      expect(expire).toHaveBeenCalledWith(account);
    }
  });
  it("aborts and discards responses after navigation even when transport ignores abort", async () => {
    let finish!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_path, options: RequestInit) => { signal = options.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }));
    const scope = createNamingRequestScope(account, () => true, vi.fn());
    const pending = scope.request("/api/private-fixture", responseSchema, isOwned);
    scope.dispose();
    expect(signal?.aborted).toBe(true);
    finish(Response.json(response));
    await expect(pending).resolves.toBeNull();
    await expect(scope.request("/api/private-fixture", responseSchema, isOwned)).resolves.toBeNull();
  });
  it("expires an active account on 401 and never carries that failure into another session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    const expire = vi.fn();
    const scope = createNamingRequestScope(account, () => true, expire);
    await expect(scope.request("/api/private-fixture", responseSchema, isOwned)).resolves.toBeNull();
    expect(expire).toHaveBeenCalledWith(account);
  });
  it("uses no-store same-origin requests and sends no owner chosen by the client", async () => {
    const fetch = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetch);
    const scope = createNamingRequestScope(account, () => true, vi.fn());
    await expect(scope.request("/api/private-fixture", responseSchema, isOwned, { method: "POST", body: { candidateId: projectId } })).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledWith("/api/private-fixture", expect.objectContaining({ cache: "no-store", credentials: "same-origin", mode: "same-origin", body: JSON.stringify({ candidateId: projectId }) }));
  });
});

describe("bounded public account error codes", () => {
  it.each(["favorite", "saved"] as const)("does not confirm an uncertain %s change on 503 or transport failure", field => {
    for (const error of [new AccountRequestError(503), new TypeError("Private network details")]) {
      expect(namingErrorMessage(error, field)).toBe(field === "favorite"
        ? "The favorite change could not be confirmed. Check the latest version before trying again."
        : "The change to saved names could not be confirmed. Check the latest version before trying again.");
    }
    expect(namingErrorMessage(new AccountRequestError(409), field)).toContain("changed");
  });
  const options = () => ({ signal: new AbortController().signal });
  it("retains the explicit capacity code without exposing the server message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "naming_history_capacity", message: "Untrusted response text" } }, { status: 409 })));
    const error = await accountRequest("/api/private-fixture", responseSchema, options()).catch(cause => cause);
    expect(error).toBeInstanceOf(AccountRequestError);
    expect(error.code).toBe("naming_history_capacity");
    expect(namingErrorMessage(error)).toBe("This project’s naming history has reached the generation limit. Your saved names are preserved.");
    expect(error.message).not.toContain("Untrusted");
  });
  it("discards unknown, malformed and oversized error envelopes", async () => {
    for (const body of [JSON.stringify({ error: { code: "unknown", message: "Private text" } }), "not json", JSON.stringify({ error: { code: "naming_history_capacity", message: "x".repeat(5000) } })]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 409, headers: { "Content-Type": "application/json" } })));
      await expect(accountRequest("/api/private-fixture", responseSchema, options())).rejects.toMatchObject({ status: 409, code: undefined });
    }
  });
  it("invalidates authentication without waiting for an error body", async () => {
    const response = Response.json({ error: { code: "naming_history_capacity" } }, { status: 401 });
    const read = vi.spyOn(response.body!, "getReader");
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(accountRequest("/api/private-fixture", responseSchema, options())).rejects.toMatchObject({ status: 401, code: undefined });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("naming admission and view", () => {
  const project = accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: "Synthetic naming-only brief", scope: "naming_only", current_revision: 2, created_at: "2026-10-04T10:00:00Z", context: { description: "Synthetic saved description", creativeLocale: "fr" } });
  const workspace = { ownerId, generation: 1, saved: project, draft: accountProjectDraft(project), conflict: false };
  it("blocks unsaved Strategy edits, conflicts and stale account memory", () => {
    expect(namingDraftBlocked(workspace, account, projectId)).toBe(false);
    expect(namingDraftBlocked({ ...workspace, draft: { ...workspace.draft, description: "An unsaved edit" } }, account, projectId)).toBe(true);
    expect(namingDraftBlocked({ ...workspace, conflict: true }, account, projectId)).toBe(true);
    expect(namingDraftBlocked(workspace, { ...account, generation: 2 }, projectId)).toBe(true);
    expect(namingDraftBlocked(workspace, { ...account, userId: projectId }, projectId)).toBe(true);
    expect(namingDraftBlocked(workspace, account, ownerId)).toBe(true);
    expect(namingDraftBlocked(null, account, projectId)).toBe(true);
  });
  it("retries one batch intent across remounts and separates later batches/preferences/policies", () => {
    const key = namingBatchIntentKey(projectId, 2, 1, 0, "a".repeat(64));
    expect(key).toBe(namingBatchIntentKey(projectId, 2, 1, 0, "a".repeat(64)));
    expect(key).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
    expect(key).not.toBe(namingBatchIntentKey(projectId, 2, 1, 1, "a".repeat(64)));
    expect(key).not.toBe(namingBatchIntentKey(projectId, 2, 2, 0, "a".repeat(64)));
    expect(key).not.toBe(namingBatchIntentKey(projectId, 2, 1, 0, "b".repeat(64)));
  });
  it("restores the loaded candidate anchor with a safe results-heading fallback", () => {
    expect(namingScrollTarget(projectId, [projectId])).toBe(`project-name-${projectId}`);
    expect(namingScrollTarget(projectId, [])).toBe("project-naming-results-heading");
    expect(namingScrollTarget(null, [projectId])).toBe("project-naming-results-heading");
  });
});

describe("focused preferences and deterministic controls", () => {
  it("keeps saved language when the optional language field is blank and does not invent constraints", () => {
    expect(parseNamingPreferenceFields({ locale: "", notes: "", minimum: "", maximum: "" }, "fr")).toEqual({ version: 1, creativeLocale: "fr", notes: "", minimumGraphemes: null, maximumGraphemes: null });
  });
  it("validates optional whole-number length bounds", () => {
    expect(parseNamingPreferenceFields({ locale: "en", notes: "Warm", minimum: "3", maximum: "8" }, "fr")).toMatchObject({ creativeLocale: "en", notes: "Warm", minimumGraphemes: 3, maximumGraphemes: 8 });
    for (const [minimum, maximum] of [["8", "3"], ["1.5", "8"], ["0", "8"], ["1", "161"]]) expect(() => parseNamingPreferenceFields({ locale: "en", notes: "", minimum: minimum!, maximum: maximum! }, "en")).toThrow();
  });
  it("produces validated deterministic input without choosing persistence", () => {
    const defaults = initialWorkshopControls();
    expect(workshopControlsInput("Lumen", { ...defaults, suffixes: "ly, io" })).toEqual({ kind: "affixes", seed: "Lumen", prefixes: [], suffixes: ["ly", "io"], separator: "" });
    expect(workshopControlsInput("Lumen", { ...defaults, kind: "swap", find: "Lu", replacement: "Nu" })).toEqual({ kind: "swap", seed: "Lumen", find: "Lu", replacement: "Nu", match: "all" });
    expect(() => workshopControlsInput("Lumen", { ...defaults, prefixes: Array.from({ length: 13 }, (_, index) => `a${index}`).join(",") })).toThrow();
  });
});
