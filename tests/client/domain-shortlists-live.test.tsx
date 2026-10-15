// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainsWorkspace } from "@/features/domain-workspace/domain-workspace";
import { domainDraftSchema, emptyDomainDraft, type DomainDraft } from "@/features/domain-workspace/draft";
import { DomainLookupError, type DomainCheck, type DomainSearchAdapter } from "@/features/domain-workspace/model";

let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === name)!;
const prepared = (domain = "fixture.ai") => domainDraftSchema.parse({ ...emptyDomainDraft(domain), candidates: [domain] });
function liveFixture(overrides: Partial<DomainCheck> = {}): DomainSearchAdapter {
  const now = Date.now();
  return { status: "ready", provider: "vercel_registrar", quotesWithCheck: true,
    check: vi.fn(async domain => ({ id: `check-${domain}`, domain, provider: "vercel_registrar", availability: "available", checkedAt: new Date(now - 100).toISOString(), validUntil: new Date(now + 60_000).toISOString(), evidenceReference: "synthetic-fixture", ...overrides })),
    quote: vi.fn(async (domain, checkId) => ({ id: `quote-${domain}`, domain, provider: "vercel_registrar", checkId, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), periodYears: 2, total: { amountMinor: 16000, currency: "USD" }, renewal: { amountMinor: 16000, currency: "USD" }, renewalTerms: "Synthetic two-year price; may change" })),
  };
}
async function render(draft: DomainDraft, adapter = liveFixture(), change = vi.fn(), disabled = false) {
  function Controlled() {
    const [value, setValue] = useState(draft);
    return <DomainsWorkspace draft={value} initialView="search" adapter={adapter} draftDisabled={disabled} onDraftChange={next => { change(next); setValue(next); }} />;
  }
  await act(async () => root.render(<Controlled />));
  return { adapter, change };
}
async function check(domain = "fixture.ai") {
  await act(async () => button(`View ${domain} details`).click());
  await act(async () => button(`Check availability for ${domain}`).click());
}

describe("live Domains prices and manual shortlist", () => {
  it("shows registration and renewal for the actual two-year term immediately after checking", async () => {
    const { adapter, change } = await render(prepared());
    await check();
    expect(host.textContent).toContain("Confirmed available");
    expect(host.textContent).toContain("USD / 2 years");
    expect(host.textContent).toContain("Renewal $160.00 / 2 years");
    expect(host.textContent).not.toContain("$160.00 / year");
    expect(host.textContent).toContain("Taxes and final checkout totals are not established here");
    if (adapter.status !== "ready") throw new Error("fixture");
    expect(adapter.check).toHaveBeenCalledTimes(1); expect(adapter.quote).toHaveBeenCalledTimes(1);
    expect(change).not.toHaveBeenCalled();
    expect(button("Purchase unavailable").disabled).toBe(true);
  });
  it("shortlists only domain names without clearing live evidence or importing purchase evidence", async () => {
    const { change } = await render(prepared());
    await check();
    await act(async () => button("Add fixture.ai to shortlist").click());
    expect(change).toHaveBeenLastCalledWith({ ...prepared(), shortlistedDomains: ["fixture.ai"] });
    expect(JSON.stringify(change.mock.calls)).not.toMatch(/amountMinor|checkedAt|vercel_registrar|orders/);
    expect(host.textContent).toContain("Confirmed available");
    await act(async () => button("Shortlist (1)").click());
    expect(host.querySelector('[aria-label="Domain shortlist"]')).not.toBeNull();
    expect(host.textContent).toContain("Renewal $160.00 / 2 years");
    expect(host.textContent).toContain("Save the account draft");
    await act(async () => button("Library").click());
    expect(host.querySelector('[aria-label="Purchased domains"]')).not.toBeNull();
    expect(host.querySelector("h3")?.textContent).not.toBe("fixture.ai");
  });
  it("keeps shortlisted names after a new search and reopens saved choices without stale availability", async () => {
    const first = { ...prepared(), shortlistedDomains: ["earlier.com"] };
    await render(first);
    await act(async () => button("Shortlist (1)").click());
    expect(host.textContent).toContain("earlier.com");
    expect(host.textContent).not.toContain("fixture.ai");
    expect(host.textContent).not.toContain("Confirmed available");
    expect(host.textContent).toContain("Not quoted");
    await act(async () => button("Remove earlier.com from shortlist").click());
    expect(host.textContent).toContain("No shortlisted domains yet");
    await act(async () => button("Search").click());
    expect(host.textContent).toContain("fixture.ai");
  });
  it("retains unknown unconfirmed results, keeps prices absent, and allows manual shortlisting", async () => {
    const adapter = liveFixture({ availability: "unknown", detail: "Vercel could not confirm availability. The domain may be unavailable or unconfirmed." });
    await render(prepared(), adapter);
    await check();
    expect(host.textContent).not.toContain("Confirmed available");
    expect(host.textContent).not.toContain("Taken");
    expect(host.textContent).toContain("unavailable or unconfirmed");
    expect(host.textContent).toContain("Not quoted");
    if (adapter.status !== "ready") throw new Error("fixture");
    expect(adapter.quote).not.toHaveBeenCalled();
    await act(async () => button("Add fixture.ai to shortlist").click());
    expect(button("Shortlist (1)")).toBeDefined();
  });
  it("does not fabricate a price when a combined lookup has no current quote", async () => {
    const adapter = liveFixture(); if (adapter.status !== "ready") throw new Error("fixture");
    adapter.quote = vi.fn(async () => { throw new Error("No current price"); });
    await render(prepared(), adapter); await check();
    expect(host.textContent).toContain("Confirmed available");
    expect(host.textContent).toContain("Not quoted");
    expect(host.textContent).toContain("no current matching price");
    expect(host.textContent).not.toContain("$160.00");
  });
  it("disables shortlist edits while account recovery fences the draft", async () => {
    const change = vi.fn(); await render(prepared(), liveFixture(), change, true);
    expect(button("Add fixture.ai to shortlist").disabled).toBe(true);
    await act(async () => button("Add fixture.ai to shortlist").click());
    expect(change).not.toHaveBeenCalled();
  });
  it("checks all visible results explicitly and reports progress without a second price request", async () => {
    const adapter = liveFixture(); await render(prepared(), adapter);
    await act(async () => button("Check availability & prices").click());
    expect(host.textContent).toContain("1 of 1 checks completed");
    expect(host.textContent).toContain("Renewal $160.00 / 2 years");
  });
  it("does not offer a saved-result brand promotion for a shortlist-only domain", async () => {
    const promote = vi.fn(); let current = { ...prepared(), shortlistedDomains: ["earlier.com"] };
    await act(async () => root.render(<DomainsWorkspace draft={current} initialView="shortlist" onDraftChange={next => { current = next as typeof current; }} onCreateBrand={promote} />));
    await act(async () => button("View earlier.com details").click());
    expect(button("Create brand from earlier.com").disabled).toBe(true);
    expect(host.textContent).toContain("use it in the current search");
    await act(async () => button("use it in the current search").click());
    expect(current.input).toBe("earlier.com"); expect(current.candidates).toEqual(["earlier.com"]);
    expect(current.shortlistedDomains).toEqual(["earlier.com"]); expect(promote).not.toHaveBeenCalled();
  });
  it("shows the mapped rate limit delay and stops further bulk lookups", async () => {
    const adapter = liveFixture(); if (adapter.status !== "ready") throw new Error("fixture");
    adapter.check = vi.fn(async () => { throw new DomainLookupError("The lookup limit was reached. Wait 125 seconds before checking again."); });
    await render(domainDraftSchema.parse({ ...emptyDomainDraft("first.com, second.com"), candidates: ["first.com", "second.com"] }), adapter);
    await act(async () => button("Check availability & prices").click());
    expect(adapter.check).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("0 of 2 checks completed");
    await act(async () => button("View first.com details").click());
    expect(host.textContent).toContain("Wait 125 seconds");
  });

});
