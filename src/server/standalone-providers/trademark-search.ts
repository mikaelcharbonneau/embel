import "server-only";
import { createHash } from "node:crypto";
import { evidenceFreshnessAt, providerResultSchema, type ProviderResult, type ProviderProvenance } from "@/domain/standalone-provider-evidence";
import { boundedProviderWork } from "./bounded-request";
import { parseProviderTarget, providerFailure, providerTime, reviewedTrademarkSourceSchema, trademarkPageSchema, trademarkResearchSchema, PROVIDER_DEADLINE_MS, type ReviewedTrademarkSource, type ProviderClock, type TrademarkTarget, type TrademarkPage, type TrademarkResearch, type TrademarkHit } from "./contracts";

const sameSet = <T>(left: T[], right: T[]) => left.length === right.length && left.every(value => right.includes(value));
function sameQuery(left: TrademarkTarget, right: TrademarkTarget): boolean { return left.tool === right.tool && left.mark === right.mark && left.mode === right.mode && sameSet(left.jurisdictions, right.jurisdictions) && sameSet(left.niceClasses, right.niceClasses); }
/** Date.parse truncates fractions, so keep sub-millisecond chronology explicit. */
function compareTime(left: string, right: string): number {
  const parts = (value: string) => ({ whole: Date.parse(value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, "")), fraction: /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] ?? "" });
  const a = parts(left), b = parts(right);
  if (a.whole !== b.whole) return a.whole < b.whole ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length), af = a.fraction.padEnd(width, "0"), bf = b.fraction.padEnd(width, "0");
  return af === bf ? 0 : af < bf ? -1 : 1;
}
const earliest = (times: string[]) => times.reduce((left, right) => compareTime(left, right) <= 0 ? left : right);
type ObservedPage = Extract<ProviderResult<TrademarkPage>, { status: "observed" }>;

/** No concrete registry source is supplied by this package. */
export function createTrademarkSearchContract(source: ReviewedTrademarkSource | null, clock: ProviderClock): { search(target: TrademarkTarget, signal: AbortSignal): Promise<ProviderResult<TrademarkResearch>> } {
  providerTime(clock);
  const validated = source === null ? null : reviewedTrademarkSourceSchema.safeParse(source);
  if (validated && !validated.success) throw new TypeError("Invalid trademark source");
  const config = validated?.success ? validated.data : null;
  return { async search(input, signal) {
    const target = parseProviderTarget(input, "trademarks"), started = providerTime(clock);
    if (signal.aborted) return providerFailure(target, "cancelled", started.iso);
    if (!config) return providerFailure(target, "unavailable", started.iso);
    const effective = { ...target, jurisdictions: target.jurisdictions.filter(key => config.jurisdictions.includes(key)) };
    if (effective.jurisdictions.length === 0) return providerFailure(target, "unsupported_target", started.iso);
    const pages: ProviderResult<TrademarkPage>[] = [], successes: ObservedPage[] = [], hits: TrademarkHit[] = [];
    const records = new Set<string>(), cursors = new Set<string>(), searched = new Set<string>();
    let cursor: string | null = null, complete = false;
    const failed = (code: Parameters<typeof providerFailure>[1], observedAt: string, retry: number | null = null) => {
      const failure = providerFailure(effective, code, observedAt, retry);
      pages.push(failure); return providerFailure(target, code, observedAt, retry);
    };
    while (pages.length < 5) {
      const before = providerTime(clock);
      if (before.ms < started.ms) throw new RangeError("Invalid provider clock");
      const result = await boundedProviderWork(rawSignal => config.readPage(structuredClone(effective), cursor, rawSignal), clock, signal, PROVIDER_DEADLINE_MS - (before.ms - started.ms));
      if (result.status === "failed") { const failure = failed(result.code, result.observedAt); if (!successes.length) return failure; break; }
      const decoded = providerResultSchema(trademarkPageSchema).safeParse(result.value);
      const measured = providerTime(clock);
      if (measured.ms < started.ms) throw new RangeError("Invalid provider clock");
      if (signal.aborted || measured.ms - started.ms >= PROVIDER_DEADLINE_MS) { const failure = failed(signal.aborted ? "cancelled" : "timeout", measured.iso); if (!successes.length) return failure; break; }
      if (!decoded.success || decoded.data.target.tool !== "trademarks" || !sameQuery(decoded.data.target, effective)) { const failure = failed("invalid_response", measured.iso); if (!successes.length) return failure; break; }
      const receipt = decoded.data;
      if (receipt.status === "failed") {
        const future = compareTime(receipt.observedAt, measured.iso) > 0;
        const failure = failed(future ? "invalid_response" : receipt.code, measured.iso, !future && receipt.code === "rate_limited" && receipt.retryAfterSeconds !== null ? Math.min(86_400, receipt.retryAfterSeconds) : null);
        if (!successes.length) return failure; break;
      }
      const { value, provenance } = receipt;
      const pageKeys = value.hits.map(hit => JSON.stringify([hit.jurisdiction, hit.registryId]));
      const previousBasis = successes[0]?.provenance.rightsBasis;
      const valid = sameQuery(value.target, effective) &&
        provenance.providerId === config.providerId && provenance.adapterVersion === config.adapterVersion && provenance.sourceUrl === config.sourceUrl &&
        (previousBasis === undefined || previousBasis === provenance.rightsBasis) && compareTime(provenance.observedAt, measured.iso) <= 0 &&
        (value.datasetAsOf === null || compareTime(value.datasetAsOf, provenance.observedAt) <= 0) &&
        value.jurisdictions.every(key => effective.jurisdictions.includes(key)) &&
        value.hits.every(hit => value.jurisdictions.includes(hit.jurisdiction) && config.allowedRecordHosts.includes(new URL(hit.recordUrl).hostname) && (hit.updatedAt === null || compareTime(hit.updatedAt, provenance.observedAt) <= 0)) &&
        new Set(pageKeys).size === pageKeys.length && pageKeys.every(key => !records.has(key)) &&
        (value.nextCursor === null || !cursors.has(value.nextCursor));
      if (!valid) { const failure = failed("invalid_response", measured.iso); if (!successes.length) return failure; break; }
      pages.push(receipt); successes.push(receipt); hits.push(...value.hits);
      pageKeys.forEach(key => records.add(key)); value.jurisdictions.forEach(key => searched.add(key));
      complete = value.complete;
      if (complete || value.nextCursor === null) break;
      cursor = value.nextCursor; cursors.add(cursor);
    }
    // At least one validated page precedes this aggregation, including partial failures.
    const completed = providerTime(clock);
    if (completed.ms < started.ms) throw new RangeError("Invalid provider clock");
    const missing = target.jurisdictions.filter(key => !searched.has(key));
    const current = successes.every(receipt => evidenceFreshnessAt(receipt.provenance, completed.ms) === "fresh" && receipt.value.datasetAsOf !== null && completed.ms - Date.parse(receipt.value.datasetAsOf) <= 86_400_000);
    const stamps = successes.map(receipt => receipt.provenance);
    const minimumCheck = stamps.every(p => p.checkedAt !== null) ? earliest(stamps.map(p => p.checkedAt!)) : null;
    const minimumExpiry = stamps.every(p => p.freshUntil !== null) ? earliest(stamps.map(p => p.freshUntil!)) : null;
    const freshUntil = minimumExpiry !== null && compareTime(minimumExpiry, completed.iso) > 0 ? earliest([minimumExpiry, new Date(completed.ms + 86_400_000).toISOString()]) : null;
    const provenance: ProviderProvenance = { providerId: config.providerId, adapterVersion: config.adapterVersion, contractVersion: 1, sourceUrl: config.sourceUrl, sourceReference: createHash("sha256").update(JSON.stringify(successes)).digest("hex"), providerRequestId: null, checkedAt: minimumCheck, observedAt: completed.iso, freshUntil, rightsBasis: successes[0]!.provenance.rightsBasis };
    return providerResultSchema(trademarkResearchSchema).parse({ status: "observed", target, provenance, value: { query: target, coverage: { requested: [...target.jurisdictions], searched: target.jurisdictions.filter(key => searched.has(key)), missing, niceEdition: config.niceEdition }, pages, hits, completeness: complete && missing.length === 0 && successes.length === pages.length && current && !signal.aborted && completed.ms - started.ms < PROVIDER_DEADLINE_MS ? "complete" : "partial", legalClearance: "not_assessed", filing: "not_submitted" } });
  } };
}
