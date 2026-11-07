import { describe, expect, it, vi } from "vitest";
import { appendEvidence, buildHandleMatrix, createEntry, declareAccountCreated, emptyHandlesState, evidenceSchema, filterBundles, handleStatus, lastCheckedAt, saveBundle, updateBundleEntry, workspaceSchema, type HandleEvidence } from "@/features/handles-workspace/domain";
import { checkHandleEntry, unavailableHandleAdapter } from "@/features/handles-workspace/adapters";
import { fixtureHandleNames, fixtureHandlesState } from "@/features/handles-workspace/fixtures";

const available: HandleEvidence = { platform: "instagram", handle: "morrow", outcome: "confirmed_available", authority: "platform_api", source: "Synthetic permitted API fixture", sourceUrl: "https://example.test/check", method: "Synthetic availability response", checkedAt: "2026-10-05T12:00:00Z", observedAt: "2026-10-05T12:00:01Z", detail: "Test fixture, not a live platform result." };
describe("Handles matrix and evidence boundaries", () => {
  it("builds consistent variants across chosen platforms and preserves source context", () => {
    const rows = buildHandleMatrix([fixtureHandleNames[0]!], ["instagram", "tiktok", "instagram"], true);
    expect(rows.map(row => row.entries.map(entry => entry.handle))).toEqual([["morrow", "morrow"], ["getmorrow", "getmorrow"], ["morrowhq", "morrowhq"]]);
    expect(rows.every(row => row.source.projectId === "fixture-brand" && row.entries.every(entry => handleStatus(entry) === "to_check"))).toBe(true);
  });
  it("rejects empty, excessive and unsupported inputs without inventing candidates", () => {
    expect(() => buildHandleMatrix([], ["x"])).toThrow();
    expect(() => buildHandleMatrix([fixtureHandleNames[0]!], [])).toThrow();
    expect(() => buildHandleMatrix(Array(31).fill(fixtureHandleNames[0]), ["x"])).toThrow();
    expect(() => buildHandleMatrix([{ ...fixtureHandleNames[0]!, name: "flower🌸" }], ["x"])).toThrow();
    expect(() => buildHandleMatrix([{ ...fixtureHandleNames[0]!, name: "a".repeat(64) }], ["x"], true)).toThrow();
  });
  it("requires a permitted source and check date for confirmed available or taken", () => {
    for (const outcome of ["confirmed_available", "taken"] as const) {
      expect(evidenceSchema.safeParse({ ...available, outcome }).success).toBe(true);
      for (const change of [{ authority: "public_profile" }, { authority: "user" }, { source: null }, { checkedAt: null }]) expect(evidenceSchema.safeParse({ ...available, outcome, ...change }).success).toBe(false);
    }
  });
  it.each(["profile_missing", "failed", "unavailable", "unknown"] as const)("keeps %s to check and retains previous evidence", outcome => {
    const confirmed = appendEvidence(createEntry("instagram", "morrow"), available);
    expect(handleStatus(confirmed)).toBe("confirmed_available");
    const next = appendEvidence(confirmed, { ...available, outcome, authority: "public_profile", checkedAt: null });
    expect(handleStatus(next)).toBe("to_check"); expect(next.evidence).toHaveLength(2); expect(next.evidence[0]).toEqual(available);
    expect(lastCheckedAt(next)).toBe(available.checkedAt);
  });
  it("rejects evidence for another exact handle or platform and dangerous links", () => {
    expect(() => appendEvidence(createEntry("instagram", "other"), available)).toThrow();
    expect(() => appendEvidence(createEntry("tiktok", "morrow"), available)).toThrow();
    expect(handleStatus({ ...createEntry("tiktok", "morrow"), evidence: [available] })).toBe("to_check");
    for (const sourceUrl of ["javascript:alert(1)", "https://user:password@example.test/"]) expect(evidenceSchema.safeParse({ ...available, sourceUrl }).success).toBe(false);
  });
  it("records account creation independently of availability, favorite and selected", () => {
    const entry = declareAccountCreated(createEntry("instagram", "morrow"), "https://www.instagram.com/morrow/", "2026-10-05T12:00:00Z");
    expect(entry.favorite).toBe(false); expect(entry.selected).toBe(false); expect(entry.evidence).toEqual([]); expect(handleStatus(entry)).toBe("to_check");
    expect(() => declareAccountCreated(entry, "https://instagram.com.attacker.test/", "2026-10-05T12:00:00Z")).toThrow();
    expect(() => declareAccountCreated(entry, "javascript:alert(1)", "2026-10-05T12:00:00Z")).toThrow();
    expect(declareAccountCreated(entry, "", "2026-10-05T12:00:00Z").accountCreated?.url).toBeNull();
  });
});
describe("Handles bundles and library", () => {
  it("saves mixed handles without treating them as selected or created", () => {
    const bundle = { ...fixtureHandlesState.bundles[0]!, entries: [createEntry("instagram", "morrow"), createEntry("tiktok", "getmorrow")] };
    const state = saveBundle(emptyHandlesState(), bundle);
    expect(state.bundles[0]!.entries.every(entry => !entry.favorite && !entry.selected && !entry.accountCreated)).toBe(true);
    expect(() => saveBundle(state, bundle)).toThrow();
    expect(() => saveBundle(emptyHandlesState(), { ...bundle, entries: [bundle.entries[0]!, bundle.entries[0]!] })).toThrow();
  });
  it("updates only the targeted saved handle and keeps original immutable", () => {
    const original = structuredClone(fixtureHandlesState);
    const next = updateBundleEntry(original, "fixture-bundle", "instagram", entry => ({ ...entry, favorite: false, selected: true }));
    expect(original.bundles[0]!.entries[0]!.favorite).toBe(true);
    expect(next.bundles[0]!.entries[0]!.selected).toBe(true);
    expect(next.bundles[0]!.entries.slice(1)).toEqual(original.bundles[0]!.entries.slice(1));
    expect(() => updateBundleEntry(next, "missing", "x", entry => entry)).toThrow();
  });
  it("filters by exact handle, project, group and distinct states", () => {
    expect(workspaceSchema.safeParse(fixtureHandlesState).success).toBe(true);
    for (const filter of ["favorite", "selected", "account_created"] as const) expect(filterBundles(fixtureHandlesState, "", filter)).toHaveLength(1);
    expect(filterBundles(fixtureHandlesState, "getmorrow", "all", "project:fixture-brand")).toHaveLength(1);
    expect(filterBundles(fixtureHandlesState, "", "all", "list:other")).toEqual([]);
    expect(filterBundles(fixtureHandlesState, "unknown")).toEqual([]);
  });
});
describe("Unavailable and failed check adapters", () => {
  it("passes only exact platform and handle to adapters", async () => {
    const check = vi.fn(async () => available);
    await checkHandleEntry({ ...createEntry("instagram", "morrow"), favorite: true, selected: true }, { availability: "ready", label: "Fixture", check });
    expect(check).toHaveBeenCalledWith({ platform: "instagram", handle: "morrow" }, expect.any(AbortSignal));
  });
  it("retains bounded evidence and sends no request when the history is full", async () => {
    const check = vi.fn();
    const entry = { ...createEntry("instagram", "morrow"), evidence: Array(100).fill(available) };
    await expect(checkHandleEntry(entry, { availability: "ready", label: "Fixture", check })).rejects.toThrow("no new check was started");
    expect(check).not.toHaveBeenCalled(); expect(entry.evidence).toHaveLength(100);
  });
  it("never calls an unavailable adapter or fetches a platform", async () => {
    const check = vi.fn(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      const result = await checkHandleEntry(createEntry("instagram", "morrow"), { ...unavailableHandleAdapter, check });
      expect(check).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      expect(handleStatus(result)).toBe("to_check"); expect(result.evidence[0]?.checkedAt).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["reject", "wrong-target", "untrusted-availability"])("turns %s into a failed, unknown result without losing history", async mode => {
    const entry = appendEvidence(createEntry("instagram", "morrow"), available);
    const result = await checkHandleEntry(entry, { availability: "ready", label: "Fixture", check: async () => {
      if (mode === "reject") throw new Error("private provider failure");
      return mode === "wrong-target" ? { ...available, handle: "other" } : { ...available, authority: "public_profile" };
    } });
    expect(handleStatus(result)).toBe("to_check"); expect(result.evidence).toHaveLength(2); expect(result.evidence[1]?.outcome).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private provider failure");
  });
  it("accepts only matching evidence and discards late cancelled responses", async () => {
    const entry = createEntry("instagram", "morrow");
    expect(handleStatus(await checkHandleEntry(entry, { availability: "ready", label: "Fixture", check: async () => available }))).toBe("confirmed_available");
    const controller = new AbortController();
    const result = await checkHandleEntry(entry, { availability: "ready", label: "Fixture", check: async () => { controller.abort(); return available; } }, controller.signal);
    expect(result).toBe(entry);
  });
});
