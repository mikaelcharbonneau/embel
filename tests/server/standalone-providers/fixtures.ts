import { vi } from "vitest";
import type { ProviderResult, ProviderTarget } from "@/domain/standalone-provider-evidence";
import type { TrademarkPage } from "@/server/standalone-providers/contracts";

/** All responses here are synthetic. No fixture transport calls the network. */
export const NOW = Date.parse("2026-10-06T12:00:00.000Z");
export const clock = () => NOW;
export const accountId = "a".repeat(32);
export const domain = "synthetic-example.test";
export const signal = () => new AbortController().signal;
export const json = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const noNetwork = () => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected ambient network call"); }));
export const trademarkTarget: Extract<ProviderTarget, { tool: "trademarks" }> = { tool: "trademarks", mark: "Café Fixture", jurisdictions: ["US"], niceClasses: [9], mode: "exact_word" };
export function page(target = trademarkTarget, patch: Partial<TrademarkPage> = {}): ProviderResult<TrademarkPage> {
  return { status: "observed", target, provenance: { providerId: "synthetic_registry", adapterVersion: "synthetic-v1", contractVersion: 1, sourceUrl: "https://registry.example.test/docs", sourceReference: "a".repeat(64), providerRequestId: null, checkedAt: new Date(NOW).toISOString(), observedAt: new Date(NOW).toISOString(), freshUntil: new Date(NOW + 60_000).toISOString(), rightsBasis: "licensed_api" }, value: { target, jurisdictions: [...target.jurisdictions], datasetAsOf: new Date(NOW).toISOString(), hits: [], nextCursor: null, complete: true, ...patch } };
}
