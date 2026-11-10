import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
import { createTrademarkSearchContract } from "@/server/standalone-providers/trademark-search";
import type { ProviderResult } from "@/domain/standalone-provider-evidence";
import type { ReviewedTrademarkSource, TrademarkPage, TrademarkTarget } from "@/server/standalone-providers/contracts";
import { clock, noNetwork, NOW, page, signal, trademarkTarget as target } from "./fixtures";
const hit = {
  registryId: "synthetic-1",
  jurisdiction: "US",
  mark: "Café Fixture",
  recordUrl: "https://registry.example.test/records/1",
  niceClasses: [9],
  statusText: "Synthetic status",
  updatedAt: new Date(NOW).toISOString(),
};
function source(
  readPage: ReviewedTrademarkSource["readPage"] = async (t) => page(t),
  patch: Partial<ReviewedTrademarkSource> = {},
): ReviewedTrademarkSource {
  return {
    providerId: "synthetic_registry",
    adapterVersion: "synthetic-v1",
    sourceUrl: "https://registry.example.test/docs",
    termsReference: "Synthetic terms; no service bound",
    allowedRecordHosts: ["registry.example.test"],
    jurisdictions: ["US"],
    niceEdition: "Synthetic-13",
    readPage,
    ...patch,
  };
}
const observed = (result: ProviderResult<TrademarkPage>) => {
  if (result.status !== "observed") throw new Error("Fixture must be observed");
  return result;
};
beforeEach(noNetwork);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("bounded trademark research", () => {
  it("unconfigured_source_is_unavailable", async () => {
    expect(await createTrademarkSearchContract(null, clock).search(target, signal())).toMatchObject({
      status: "failed",
      code: "unavailable",
    });
  });
  it("empty_results_never_clear_a_mark", async () => {
    const result = await createTrademarkSearchContract(source(), clock).search(target, signal());
    expect(result).toMatchObject({
      status: "observed",
      target,
      value: {
        query: target,
        hits: [],
        completeness: "complete",
        legalClearance: "not_assessed",
        filing: "not_submitted",
        coverage: { requested: ["US"], searched: ["US"], missing: [] },
      },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("retains_completed_pages_on_failure", async () => {
    const first = page(target, { hits: [hit], complete: false, nextCursor: "page-2" });
    const readPage = vi
      .fn<ReviewedTrademarkSource["readPage"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({
        status: "failed",
        target,
        code: "rate_limited",
        retryAfterSeconds: 60,
        observedAt: new Date(NOW).toISOString(),
      });
    const result = await createTrademarkSearchContract(source(readPage), clock).search(target, signal());
    expect(result).toMatchObject({
      status: "observed",
      value: {
        completeness: "partial",
        hits: [hit],
        pages: [first, { status: "failed", code: "rate_limited", retryAfterSeconds: 60 }],
      },
    });
    expect(readPage).toHaveBeenCalledTimes(2);
  });
  it("reports_missing_territory_and_stale_dataset", async () => {
    const requested = { ...target, jurisdictions: ["US", "CA"] };
    const readPage = vi.fn(async (effective: TrademarkTarget) =>
      page(effective, { datasetAsOf: new Date(NOW - 86_400_001).toISOString() }),
    );
    const result = await createTrademarkSearchContract(source(readPage), clock).search(requested, signal());
    expect(result).toMatchObject({
      status: "observed",
      target: requested,
      value: { query: requested, completeness: "partial", coverage: { searched: ["US"], missing: ["CA"] } },
    });
    expect(readPage.mock.calls[0]![0]).toEqual(target);
  });
  it("unsupported_coverage_sends_nothing", async () => {
    const readPage = vi.fn(async () => page());
    expect(
      await createTrademarkSearchContract(source(readPage), clock).search(
        { ...target, jurisdictions: ["CA"] },
        signal(),
      ),
    ).toMatchObject({ code: "unsupported_target" });
    expect(readPage).not.toHaveBeenCalled();
  });
  it("rejects_changed_queries_and_poisoned_record_urls", async () => {
    for (const invalid of [
      page({ ...target, mark: "Cafe Fixture" }),
      page({ ...target, niceClasses: [35] }),
      page(target, { target: { ...target, mode: "similarity" } as unknown as TrademarkTarget }),
      page(target, { jurisdictions: ["CA"] }),
      page(target, { hits: [{ ...hit, recordUrl: "https://registry.example.test.evil.test/1" }] }),
      page(target, { hits: [{ ...hit, recordUrl: "https://127.0.0.1/1" }] }),
      page(target, { hits: [{ ...hit, recordUrl: "https://registry.example.test/1?secret=yes" }] }),
    ]) {
      const readPage = vi.fn(async () => invalid);
      expect(await createTrademarkSearchContract(source(readPage), clock).search(target, signal())).toMatchObject({
        code: "invalid_response",
      });
      expect(readPage).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects_hostile_constructor_urls_before_dispatch", () => {
    for (const url of [
      "https://127.0.0.1/docs",
      "https://localhost/docs",
      "https://[::1]/docs",
      "https://registry.example.test/docs?token=x",
      "not-a-url",
    ])
      expect(() => createTrademarkSearchContract(source(undefined, { sourceUrl: url }), clock)).toThrow(
        "Invalid trademark source",
      );
    expect(() =>
      createTrademarkSearchContract(source(undefined, { allowedRecordHosts: ["127.0.0.1"] }), clock),
    ).toThrow("Invalid trademark source");
  });
  it("unknown_dataset_or_unknown_page_freshness_is_partial", async () => {
    for (const receipt of [
      page(target, { datasetAsOf: null }),
      { ...observed(page()), provenance: { ...observed(page()).provenance, freshUntil: null } },
      { ...observed(page()), provenance: { ...observed(page()).provenance, checkedAt: null } },
    ])
      expect(
        await createTrademarkSearchContract(
          source(async () => receipt),
          clock,
        ).search(target, signal()),
      ).toMatchObject({ status: "observed", value: { completeness: "partial" } });
  });
  it("rejects_future_dataset_observation_and_record_times", async () => {
    const future = new Date(NOW + 1).toISOString();
    for (const receipt of [
      page(target, { datasetAsOf: future }),
      page(target, { hits: [{ ...hit, updatedAt: future }] }),
      { ...observed(page()), provenance: { ...observed(page()).provenance, observedAt: future } },
    ])
      expect(
        await createTrademarkSearchContract(
          source(async () => receipt),
          clock,
        ).search(target, signal()),
      ).toMatchObject({ code: "invalid_response" });
  });
  it("bounds_five_pages_and_retains_500_hits", async () => {
    let index = 0;
    const readPage = vi.fn(async (t: TrademarkTarget) =>
      page(t, {
        complete: false,
        nextCursor: String(++index),
        hits: Array.from({ length: 100 }, (_, n) => ({ ...hit, registryId: `page-${index}-hit-${n}` })),
      }),
    );
    const result = await createTrademarkSearchContract(source(readPage), clock).search(target, signal());
    expect(result).toMatchObject({ status: "observed", value: { completeness: "partial" } });
    if (result.status === "observed") {
      expect(result.value.pages).toHaveLength(5);
      expect(result.value.hits).toHaveLength(500);
    }
    expect(readPage).toHaveBeenCalledTimes(5);
  });
  it("rejects_101_hits_duplicate_records_and_repeated_cursors", async () => {
    for (const receipt of [
      page(target, { hits: Array.from({ length: 101 }, (_, n) => ({ ...hit, registryId: String(n) })) }),
      page(target, { hits: [hit, { ...hit, mark: "Conflicting" }] }),
    ])
      expect(
        await createTrademarkSearchContract(
          source(async () => receipt),
          clock,
        ).search(target, signal()),
      ).toMatchObject({ code: "invalid_response" });
    const readPage = vi.fn(async (t: TrademarkTarget) => page(t, { complete: false, nextCursor: "same" }));
    const result = await createTrademarkSearchContract(source(readPage), clock).search(target, signal());
    expect(result).toMatchObject({
      status: "observed",
      value: {
        completeness: "partial",
        pages: [expect.objectContaining({ status: "observed" }), expect.objectContaining({ code: "invalid_response" })],
      },
    });
    expect(readPage).toHaveBeenCalledTimes(2);
  });
  it("rejects_page_payload_over_262144_bytes_even_with_100_hits", async () => {
    const receipt = page(target, {
      hits: Array.from({ length: 100 }, (_, n) => ({
        ...hit,
        registryId: String(n).padEnd(200, "x"),
        mark: "m".repeat(160),
        statusText: "s".repeat(200),
        recordUrl: "https://registry.example.test/" + "x".repeat(2000),
      })),
    });
    expect(
      await createTrademarkSearchContract(
        source(async () => receipt),
        clock,
      ).search(target, signal()),
    ).toMatchObject({ code: "invalid_response" });
  });
  it("treats_submillisecond_dataset_age_over_24_hours_as_partial", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const receipt = page(target, { datasetAsOf: "2026-10-05T11:59:59.999999Z" });
    expect(
      await createTrademarkSearchContract(
        source(async () => receipt),
        clock,
      ).search(target, signal()),
    ).toMatchObject({ status: "observed", value: { completeness: "partial" } });
  });

  it("rejects_duplicate_record_across_pages_preserving_original", async () => {
    const readPage = vi
      .fn<ReviewedTrademarkSource["readPage"]>()
      .mockResolvedValueOnce(page(target, { hits: [hit], complete: false, nextCursor: "2" }))
      .mockResolvedValueOnce(page(target, { hits: [{ ...hit, mark: "Conflicting" }] }));
    expect(await createTrademarkSearchContract(source(readPage), clock).search(target, signal())).toMatchObject({
      status: "observed",
      value: { completeness: "partial", hits: [hit] },
    });
  });
  it("requires_matching_provider_version_source_and_rights", async () => {
    for (const provenance of [
      { providerId: "other" },
      { adapterVersion: "other" },
      { sourceUrl: "https://other.test/docs" },
    ]) {
      const receipt = observed(page());
      receipt.provenance = { ...receipt.provenance, ...provenance };
      expect(
        await createTrademarkSearchContract(
          source(async () => receipt),
          clock,
        ).search(target, signal()),
      ).toMatchObject({ code: "invalid_response" });
    }
    const second = observed(page());
    second.provenance.rightsBasis = "official_api";
    const readPage = vi
      .fn<ReviewedTrademarkSource["readPage"]>()
      .mockResolvedValueOnce(page(target, { complete: false, nextCursor: "2" }))
      .mockResolvedValueOnce(second);
    expect(await createTrademarkSearchContract(source(readPage), clock).search(target, signal())).toMatchObject({
      status: "observed",
      value: { completeness: "partial" },
    });
  });
  it("uses_minimum_expiry_and_hashes_ordered_validated_receipts", async () => {
    const first = observed(page(target, { complete: false, nextCursor: "2" })),
      second = observed(page());
    second.provenance.freshUntil = new Date(NOW + 30_000).toISOString();
    second.provenance.sourceReference = "b".repeat(64);
    const readPage = vi
      .fn<ReviewedTrademarkSource["readPage"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const result = await createTrademarkSearchContract(source(readPage), clock).search(target, signal());
    expect(result).toMatchObject({
      status: "observed",
      provenance: {
        freshUntil: second.provenance.freshUntil,
        providerRequestId: null,
        sourceReference: createHash("sha256")
          .update(JSON.stringify([first, second]))
          .digest("hex"),
      },
    });
  });
  it("expired_at_completion_preserves_history_but_has_no_current_expiry", async () => {
    let now = NOW;
    const first = observed(page(target, { complete: false, nextCursor: "2" }));
    first.provenance.freshUntil = new Date(NOW + 1).toISOString();
    const readPage = vi
      .fn<ReviewedTrademarkSource["readPage"]>()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(async () => {
        now += 2;
        return page();
      });
    const result = await createTrademarkSearchContract(source(readPage), () => now).search(target, signal());
    expect(result).toMatchObject({
      status: "observed",
      provenance: { freshUntil: null },
      value: { completeness: "partial", pages: [first, expect.anything()] },
    });
  });
  it("caps_aggregate_expiry_at_24_hours", async () => {
    const receipt = observed(page());
    receipt.provenance.freshUntil = new Date(NOW + 172_800_000).toISOString();
    expect(
      await createTrademarkSearchContract(
        source(async () => receipt),
        clock,
      ).search(target, signal()),
    ).toMatchObject({ provenance: { freshUntil: new Date(NOW + 86_400_000).toISOString() } });
  });
  it("settles_ignored_abort_without_publishing_late_pages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let resolve!: (receipt: ProviderResult<TrademarkPage>) => void;
    const readPage = vi.fn(
      () =>
        new Promise<ProviderResult<TrademarkPage>>((r) => {
          resolve = r;
        }),
    );
    const pending = createTrademarkSearchContract(source(readPage), Date.now).search(target, signal());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ status: "failed", code: "timeout" });
    resolve(page());
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains_first_page_on_ignored_second_page_cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const controller = new AbortController();
    const readPage = vi
      .fn<ReviewedTrademarkSource["readPage"]>()
      .mockResolvedValueOnce(page(target, { complete: false, nextCursor: "2", hits: [hit] }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const pending = createTrademarkSearchContract(source(readPage), Date.now).search(target, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toMatchObject({
      status: "observed",
      value: {
        completeness: "partial",
        hits: [hit],
        pages: [expect.anything(), expect.objectContaining({ code: "cancelled" })],
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("enforces_one_total_deadline_not_15_seconds_per_page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const readPage = vi
      .fn<ReviewedTrademarkSource["readPage"]>()
      .mockImplementationOnce(async (t) => {
        await new Promise((r) => setTimeout(r, 10_000));
        return page(t, { complete: false, nextCursor: "2" });
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    const pending = createTrademarkSearchContract(source(readPage), Date.now).search(target, signal());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({
      status: "observed",
      value: { completeness: "partial", pages: [expect.anything(), expect.objectContaining({ code: "timeout" })] },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps_source_mutation_from_changing_the_requested_query", async () => {
    const original = structuredClone(target);
    const readPage = vi.fn(async (t: TrademarkTarget) => {
      t.mark = "Changed by source";
      return page(t);
    });
    const result = await createTrademarkSearchContract(source(readPage), clock).search(original, signal());
    expect(original).toEqual(target);
    expect(result).toMatchObject({ status: "failed", target, code: "invalid_response" });
  });
});
