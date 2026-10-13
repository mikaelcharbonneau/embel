// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HandlesWorkspace } from "@/features/handles-workspace/handles-workspace";
import { emptyHandlesState, type HandlesState } from "@/features/handles-workspace/domain";
import { parseHandlesDraft } from "@/features/handles-workspace/account-codec";
import { unavailableEvidence, type HandleCheckAdapter } from "@/features/handles-workspace/adapters";
import { TrademarkLiveResearch } from "@/components/tools/trademark-live-research";
import { createTrademarkDraft } from "@/features/trademark-workspace/domain";
import { type TrademarkLookupAdapter } from "@/components/tools/standalone-live-client";
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text)!;

it("keeps live observations in the comparison while bookmarking a valid manual account bundle", async () => {
  let saved: HandlesState | null = null;
  const adapter: HandleCheckAdapter = { availability: "ready", label: "Synthetic profile lookup", async check(entry) { return { ...unavailableEvidence(entry, new Date().toISOString()), outcome: "unknown", detail: "Synthetic profile observation" }; } };
  await act(async () => root.render(<HandlesWorkspace value={emptyHandlesState()} onChange={(value: HandlesState) => { saved = value; }} adapter={adapter} saveCheckEvidence={false} />));
  const input = host.querySelector<HTMLInputElement>('[aria-label="Business handles"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => button("Check handles").click());
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Save @fixture from fixture to library"]')!.click());
  expect(saved).not.toBeNull(); const parsed = parseHandlesDraft(saved); expect(parsed.bundles).toHaveLength(1);
  expect(parsed.bundles[0]!.entries.every(entry => entry.evidence.length === 0)).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Details for @fixture from fixture"]')!.click());
  expect(host.textContent).toContain("Synthetic profile observation");
});

it("cancels transient EUIPO research on criterion remount and never publishes a late result", async () => {
  let captured: AbortSignal | null = null;
  const search = vi.fn((_input: unknown, signal: AbortSignal) => { captured = signal; return new Promise<never>(() => {}); });
  const adapter: TrademarkLookupAdapter = { ready: true, search };
  const draft = { ...createTrademarkDraft("Fixture"), territories: ["European Union", "Canada"] };
  await act(async () => root.render(createElement(TrademarkLiveResearch, { key: "original", draft, adapter, disabled: false })));
  await act(async () => button("Search exact EU name").click());
  expect(search).toHaveBeenCalledWith({ tool: "trademarks", mark: "Fixture", jurisdictions: ["EM", "CA"], niceClasses: [], mode: "exact_word" }, expect.any(AbortSignal));
  await act(async () => root.render(createElement(TrademarkLiveResearch, { key: "changed", draft: { ...draft, markName: "Changed" }, adapter, disabled: false })));
  expect((captured as AbortSignal | null)?.aborted).toBe(true); expect(host.textContent).not.toContain("Searching EUIPO…");
});
