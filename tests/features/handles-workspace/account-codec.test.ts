import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyHandlesDraft, handlesDraftSchema, parseHandlesDraft, standalonePayloadCodec } from "@/features/handles-workspace/account-codec";
import { createEntry, declareAccountCreated, entrySchema, handleStatus, workspaceSchema, type HandlesState } from "@/features/handles-workspace/domain";

const at = "2026-10-05T12:00:00Z";
function draft(): HandlesState {
  return { version: 1, bundles: [{ id: "bundle-1", title: "Fixture", list: "Personal", source: { id: "manual-fixture", name: "Fixture", origin: "manual", projectId: null, projectTitle: null }, savedAt: at,
    entries: [declareAccountCreated({ ...createEntry("instagram", "fixture"), favorite: true, selected: true }, "https://instagram.com/fixture", at)] }] };
}

afterEach(() => vi.useRealTimers());

describe("strict persisted Handles user draft codec", () => {
  it.each([
    "https://xn--.instagram.com/fixture", "https://xn--bcher-kva.instagram.com/fixture",
    "https://bücher.instagram.com/fixture", "https://%77ww.instagram.com/fixture",
    " https://www.instagram.com/fixture", "https://www.instagram.com\\@example.invalid/fixture",
  ])("rejects noncanonical platform authority before a database save: %s", url => {
    const payload = draft(); payload.bundles[0]!.entries[0]!.accountCreated!.url = url;
    expect(handlesDraftSchema.safeParse(payload).success).toBe(false);
    expect(payload.bundles[0]!.entries[0]!.accountCreated!.url).toBe(url);
  });

  it.each([
    "HTTPS://WWW.INSTAGRAM.COM/Some%20Path?q=hello#section",
    "https://business.instagram.com/équipe?view=one two#résumé",
    "https://www.instagram.com:00000080/a path?profile=@fixture#bio",
  ])("retains supported platform spellings and international paths unchanged: %s", url => {
    const payload = draft(); payload.bundles[0]!.entries[0]!.accountCreated!.url = url;
    expect(parseHandlesDraft(payload).bundles[0]!.entries[0]!.accountCreated!.url).toBe(url);
  });

  it("round-trips user bundles, independent retention and an unverified declaration", () => {
    const input = draft(), saved = parseHandlesDraft(JSON.parse(JSON.stringify(input)));
    expect(saved).toEqual(input);
    expect(handleStatus(saved.bundles[0]!.entries[0]!)).toBe("to_check");
    expect(standalonePayloadCodec.tool).toBe("handles");
    expect(parseHandlesDraft(createEmptyHandlesDraft())).toEqual({ version: 1, bundles: [] });
    saved.bundles[0]!.title = "Changed";
    expect(input.bundles[0]!.title).toBe("Fixture");
  });

  it.each(["confirmed_available", "taken", "profile_missing", "unavailable", "failed", "unknown"] as const)("rejects %s evidence even when structurally valid", outcome => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-06T00:00:00Z"));
    const payload = draft();
    payload.bundles[0]!.entries[0]!.evidence = [{ platform: "instagram", handle: "fixture", outcome, authority: "platform_api", source: "Forged API", sourceUrl: null, method: "Claim", checkedAt: at, observedAt: at, detail: "Not a real check" }];
    expect(handlesDraftSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects ownership and provider fields at every persisted level", () => {
    const payload = draft(), bundle = payload.bundles[0]!, entry = bundle.entries[0]!;
    const variants = [
      { ...payload, ownerId: "someone" }, { ...payload, providerAvailability: "ready" },
      { ...payload, bundles: [{ ...bundle, owned: true }] },
      { ...payload, bundles: [{ ...bundle, source: { ...bundle.source, ownerId: "someone" } }] },
      { ...payload, bundles: [{ ...bundle, entries: [{ ...entry, status: "confirmed_available" }] }] },
      { ...payload, bundles: [{ ...bundle, entries: [{ ...entry, accountCreated: { ...entry.accountCreated, verified: true } }] }] },
    ];
    for (const variant of variants) expect(handlesDraftSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects malformed URLs/dates, inconsistent source labels, duplicate IDs/platforms and excess bounds", () => {
    const payload = draft(), bundle = payload.bundles[0]!, entry = bundle.entries[0]!;
    const variants = [null, { version: 2, bundles: [] }, { ...payload, bundles: [bundle, bundle] }, { ...payload, bundles: Array(201).fill(bundle) },
      { ...payload, bundles: [{ ...bundle, source: { ...bundle.source, projectId: "foreign-project" } }] },
      { ...payload, bundles: [{ ...bundle, source: { ...bundle.source, origin: "project" } }] },
      { ...payload, bundles: [{ ...bundle, source: { ...bundle.source, origin: "names", projectTitle: "Orphan" } }] },
      { ...payload, bundles: [{ ...bundle, entries: [entry, entry] }] },
      { ...payload, bundles: [{ ...bundle, entries: [{ ...entry, handle: "💥" }] }] },
      { ...payload, bundles: [{ ...bundle, savedAt: "2026-02-30T00:00:00Z" }] },
      { ...payload, bundles: [{ ...bundle, entries: [{ ...entry, accountCreated: { declaredAt: "bad", url: null } }] }] },
      ...["javascript:alert(1)", "https://instagram.com.evil.test/", "https://name:secret@instagram.com/"].map(url => ({ ...payload, bundles: [{ ...bundle, entries: [{ ...entry, accountCreated: { declaredAt: at, url } }] }] })),
    ];
    for (const variant of variants) expect(handlesDraftSchema.safeParse(variant).success).toBe(false);
  });

  it("bounds UTF-8 bytes and does not silently drop oversized bundles", () => {
    const bundle = draft().bundles[0]!;
    const payload = { version: 1, bundles: Array.from({ length: 100 }, (_, i) => ({ ...bundle, id: `bundle-${i}`, title: "界".repeat(160), list: "界".repeat(160) })) };
    expect(handlesDraftSchema.safeParse(payload).success).toBe(false);
    expect(payload.bundles).toHaveLength(100);
  });

  it.each([
    "https://www.instagram.com:99999/cedar", "https://instagram.com:65536/cedar",
    "https://instagram.com:-1/cedar", "https://instagram.com:port/cedar",
    "not a URL", "https://",
  ])("returns a validation failure without throwing for malformed declaration URL %s", url => {
    const input = draft();
    const entry = input.bundles[0]!.entries[0]!;
    entry.accountCreated = { declaredAt: at, url };
    const original = structuredClone(input);
    for (const parse of [() => entrySchema.safeParse(entry), () => workspaceSchema.safeParse(input), () => handlesDraftSchema.safeParse(input)]) {
      expect(() => parse()).not.toThrow();
      const result = parse();
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.some(issue => issue.path.at(-1) === "url")).toBe(true);
    }
    expect(input).toEqual(original);
  });

  it.each([
    "https://instagram.com/cedar", "http://instagram.com:80/cedar", "https://instagram.com:0/cedar",
    "https://instagram.com:65535/cedar", "https://WWW.Instagram.Com:443/cedar?view=posts#top",
    "https://business.instagram.com/%63edar?lang=en#about",
  ])("preserves valid platform declaration URL and timestamps exactly: %s", url => {
    const input = draft();
    input.bundles[0]!.entries[0]!.accountCreated = { declaredAt: "2026-10-05T13:00:00+01:00", url };
    const result = handlesDraftSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(result.data).toEqual(input);
    expect(handleStatus(result.data.bundles[0]!.entries[0]!)).toBe("to_check");
    expect(result.data.bundles[0]!.entries[0]!.evidence).toEqual([]);
  });
});
