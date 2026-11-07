// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainsWorkspace } from "@/features/domain-workspace/domain-workspace";
import { emptyDomainDraft } from "@/features/domain-workspace/draft";
import { type DomainSearchAdapter } from "@/features/domain-workspace/model";
import { HandlesWorkspace } from "@/features/handles-workspace/handles-workspace";
import { emptyHandlesSearch, emptyHandlesState } from "@/features/handles-workspace/domain";
import { type HandleCheckAdapter } from "@/features/handles-workspace/adapters";
import { TrademarkWorkspace } from "@/features/trademark-workspace/trademark-workspace";
import { createTrademarkDraft } from "@/features/trademark-workspace/domain";

let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function button(name: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === name);
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
}
async function click(name: string) { await act(async () => button(name).click()); }
async function input(field: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
}
const domainDraft = { ...emptyDomainDraft("synthetic.com"), candidates: ["synthetic.com"] };

describe("utility task hierarchy", () => {
  it("puts all Domain views before search and keeps provider identifiers in details with unknown evidence", async () => {
    const check = vi.fn(), quote = vi.fn();
    const adapter: DomainSearchAdapter = { status: "ready", provider: "namecom_core", check, quote };
    await act(async () => root.render(<DomainsWorkspace initialView="search" draft={domainDraft} onDraftChange={vi.fn()} adapter={adapter} />));
    const navigation = host.querySelector('[aria-label="Domain views"]')!;
    const search = host.querySelector('[aria-label="Domain search workspace"]')!;
    expect(navigation.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...navigation.querySelectorAll("button")].map(item => item.textContent)).toEqual(["Search", "Shortlist", "Library"]);
    const status = host.querySelector('[aria-label="synthetic.com availability"]')!;
    expect(status.textContent).toBe("Unknown");
    expect(status.parentElement?.textContent).toBe("Unknown · Name.com");
    expect(status.parentElement?.textContent).not.toContain("namecom_core");
    expect(host.textContent).toContain("Not quoted");
    await click("View synthetic.com details");
    expect(host.querySelector(`[id$="-details-synthetic.com"]`)?.textContent).toContain("Not checked yet.");
    expect(host.textContent).not.toContain("namecom_core");
    expect(check).not.toHaveBeenCalled(); expect(quote).not.toHaveBeenCalled();
  });

  it("keeps result selection and filter input nodes across a contained disclosure, returning focus on Escape", async () => {
    await act(async () => root.render(<DomainsWorkspace initialView="search" draft={domainDraft} onDraftChange={vi.fn()} />));
    await click("View synthetic.com details");
    const selected = host.querySelector<HTMLInputElement>('[aria-label="Select synthetic.com"]')!;
    await act(async () => selected.click());
    await click("Edit filters");
    await click("Technology");
    const query = host.querySelector<HTMLInputElement>('[aria-label="Domain search filters"] input[type="search"]')!;
    await input(query, "ai");
    query.focus();
    await act(async () => query.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(button("Edit filters").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button("Edit filters"));
    expect(host.querySelector<HTMLElement>('[aria-label="Domain search filters"]')!.hidden).toBe(true);
    await click("Edit filters");
    expect(host.querySelector('[aria-label="Domain search filters"] input[type="search"]')).toBe(query);
    expect(query.value).toBe("ai");
    expect(button("Technology").getAttribute("aria-pressed")).toBe("true");
    expect(selected.checked).toBe(true);
    expect(host.textContent).toContain("Result actions · 1 selected");
    await click("Done");
    expect(document.activeElement).toBe(button("Edit filters"));
    await click("Edit filters");
    query.focus();
    await act(async () => button("View synthetic.com details").focus());
    expect(button("Edit filters").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button("View synthetic.com details"));
    expect(host.querySelector('[aria-label="Active domain filters"]')?.textContent).toContain("Taken domains hidden");
    expect(host.textContent).not.toContain("Premium included");
  });

  it("makes local handle comparison primary without starting a configured check", async () => {
    const check = vi.fn();
    const adapter: HandleCheckAdapter = { availability: "ready", label: "Synthetic connected adapter", check };
    const state = { ...emptyHandlesState(), search: { ...emptyHandlesSearch(), names: "synthetic" } };
    await act(async () => root.render(<HandlesWorkspace initialState={state} adapter={adapter} />));
    expect(button("Build comparison").classList.contains("primary")).toBe(true);
    expect(button("Build comparison").disabled).toBe(false);
    expect(button("Check handles").classList.contains("secondary")).toBe(true);
    await click("Build comparison");
    expect(host.querySelector('[aria-label="Handle comparison matrix"]')).not.toBeNull();
    expect(host.textContent).toContain("ready to compare");
    expect(check).not.toHaveBeenCalled();
  });

  it("connects the compact handle preview to its focus target and exposes disconnection as status", async () => {
    const state = { ...emptyHandlesState(), search: { ...emptyHandlesSearch(), names: "synthetic" } };
    await act(async () => root.render(<HandlesWorkspace initialState={state} />));
    const summary = host.querySelector('[aria-label="Candidate preview summary"]')!;
    expect(summary.textContent).toContain("@synthetic");
    const link = summary.querySelector<HTMLAnchorElement>("a")!;
    const target = document.getElementById(link.hash.slice(1))!;
    expect(target.getAttribute("aria-label")).toBe("Handles preview");
    await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(target);
    expect(host.textContent).toContain("It doesn’t check whether they’re taken yet.");
    expect(host.textContent).not.toContain("not connected");
    expect([...host.querySelectorAll('[role="tab"]')].map(item => item.textContent)).toEqual(["Search", "Library", "Saved"]);
    expect([...host.querySelectorAll("button")].some(item => item.textContent === "Check handles")).toBe(false);
    expect(button("Build comparison").disabled).toBe(false);
  });

  it("offers one useful entry action in an empty handle library", async () => {
    await act(async () => root.render(<HandlesWorkspace initialView="library" />));
    expect(button("Compare handles").disabled).toBe(false);
    expect(host.querySelector(".handles-toolbar")).toBeNull();
    expect(host.textContent).not.toContain("Export library CSV");
    expect(host.querySelector('[aria-label="Search library"]')).toBeNull();
  });

  it("distinguishes manual criteria and registry coverage before any trademark action", async () => {
    const change = vi.fn();
    const draft = { ...createTrademarkDraft("Synthetic"), territories: ["Canada"] };
    await act(async () => root.render(<TrademarkWorkspace draft={draft} onChange={change} liveResearch={<section aria-label="Synthetic source">European Union exact-name source · disconnected</section>} />));
    expect([...host.querySelectorAll('[role="tab"]')].map(item => item.textContent)).toEqual(["Search", "Details", "Summary", "Save history"]);
    expect(button("Prepare search").type).toBe("submit");
    expect(host.querySelector(".tool-heading p")?.textContent).toContain("can check exact names in the EU register");
    expect(host.querySelector('[aria-label="Registry evidence"]')?.textContent).toContain("aren’t saved with your draft");
    expect(change).not.toHaveBeenCalled();
  });

  it("retains the actual draft and receipt across keyboard task navigation without saving", async () => {
    const change = vi.fn();
    function Controlled() {
      const [draft, setDraft] = useState({ ...createTrademarkDraft("Synthetic retained"), territories: ["Canada"], userNotes: "User note only" });
      return <TrademarkWorkspace draft={draft} onChange={next => { change(next); setDraft(next); }} savedDraft={{ revision: 4, updatedAt: "2026-10-20T12:00:00Z", dirty: true }} />;
    }
    await act(async () => root.render(<Controlled />));
    expect(host.querySelector(".tool-heading p")?.textContent).toContain("it doesn’t search registries for you");
    button("Search").focus();
    await act(async () => button("Search").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(button("Details"));
    expect(host.textContent).toContain("Your draft");
    expect(host.textContent).toContain("Missing");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Mark name"]')?.value).toBe("Synthetic retained");
    await click("Summary");
    expect(host.textContent).toContain("Your trademark notes live in one draft");
    expect(host.textContent).toContain("Version 4 · unsaved changes");
    await click("Save history");
    expect(host.textContent).toContain("When this draft was last saved");
    expect(host.textContent).toContain("Your latest edits aren’t saved yet");
    expect(host.textContent).toContain("Only the last save is shown");
    await act(async () => button("Save history").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(button("Search"));
    expect(host.querySelector<HTMLInputElement>('[aria-label="Mark name"]')?.value).toBe("Synthetic retained");
    expect(change).not.toHaveBeenCalled();
  });
});
