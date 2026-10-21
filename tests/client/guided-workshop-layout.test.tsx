// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDialogMethods } from "../helpers/dialog-methods";
import { GuidedWorkshop } from "@/components/naming/guided-workshop";
import { createNamesStore } from "@/components/naming/local-names";
import { emptyGuidedUi } from "@/components/naming/guided-names";
import { NameCandidateCard } from "@/components/naming/name-candidate-card";

const mock = vi.hoisted(() => ({ store: null as ReturnType<typeof createNamesStore> | null }));
vi.mock("@/components/naming/use-names-store", () => ({ useNamesActions: () => mock.store }));
let host: HTMLDivElement, root: Root, restoreDialogs: () => void;
const store = () => mock.store!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label") === label || node.textContent === label)!;
function Harness() {
  const value = useSyncExternalStore(store().subscribe, store().getSnapshot, store().getSnapshot);
  return <GuidedWorkshop ui={value.data.ui} candidates={value.data.candidates} onResult={() => {}} />;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function input(node: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function render() { await act(async () => root.render(<Harness />)); }
beforeEach(() => {
  restoreDialogs = installDialogMethods();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let raw: string | null = null;
  mock.store = createNamesStore({ storage: () => ({ getItem: () => raw, setItem: (_key, value) => { raw = value; } }), createId: () => crypto.randomUUID() });
  store().hydrate(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); restoreDialogs(); vi.unstubAllGlobals(); });

it("keeps empty, single-word and many-word counts explicit without changing delimiter behavior", async () => {
  await render(); expect(host.querySelector(".names-word-count")!.textContent).toBe("0 words");
  expect(host.textContent).toContain("Separate words with commas");
  const field = host.querySelector<HTMLInputElement>("#names-guided-word")!;
  field.focus(); await input(field, "one phrase, cedar, cedar");
  await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(store().getSnapshot().data.ui.guided!.words.map(word => word.value)).toEqual(["one phrase", "cedar"]);
  expect(host.querySelector(".names-word-count")!.textContent).toBe("2 words");
  expect(host.querySelector("#names-guided-word")).toBe(field); expect(document.activeElement).toBe(field);
  await click("Remove word one phrase"); expect(host.querySelector(".names-word-count")!.textContent).toBe("1 word");
  await click("Clear"); expect(host.querySelector(".names-word-count")!.textContent).toBe("0 words");
  expect(host.textContent).toContain("Add your own words to see results");
});

it("bounds a long retained comma-containing seed without reparsing it, with full text available on expansion", async () => {
  const value = "interface, application, independent visual reference, graphic identity, a longer retained name to keep unchanged";
  store().updateUi({ guided: { ...emptyGuidedUi(), words: [{ value, candidateId: null }] } });
  await render();
  expect(host.querySelectorAll(".names-word-chip")).toHaveLength(1);
  const disclosure = host.querySelector<HTMLElement>(".names-long-word")!, summary = disclosure.querySelector<HTMLButtonElement>(":scope > button")!;
  expect(disclosure.querySelector("dialog")!.open).toBe(false); expect(summary.getAttribute("title")).toBe(value); expect(summary.textContent).toContain(value);
  summary.focus(); await act(async () => summary.click()); expect(disclosure.querySelector("dialog")!.open).toBe(true);
  await act(async () => store().updateUi({ query: "unrelated saved view change" }));
  expect(host.querySelector(".names-long-word")).toBe(disclosure); expect(disclosure.querySelector("dialog")!.open).toBe(true); expect(disclosure.querySelector("dialog")!.contains(document.activeElement)).toBe(true);
  expect(store().getSnapshot().data.ui.guided!.words).toEqual([{ value, candidateId: null }]);
});

it("switches narrow controls/preview presentation without unmounting or saving view-only changes", async () => {
  store().updateUi({ guided: { ...emptyGuidedUi(), words: [{ value: "cedar", candidateId: null }] } });
  await render(); const field = host.querySelector("#names-guided-word"), controls = host.querySelector("#names-guided-controls"), results = host.querySelector("#names-guided-results");
  const before = structuredClone(store().getSnapshot().data);
  const preview = button("Preview · 1"); preview.focus(); await click("Preview · 1");
  expect(host.querySelector("[data-workshop-view]")!.getAttribute("data-workshop-view")).toBe("preview");
  expect(document.activeElement).toBe(preview); expect(preview.getAttribute("aria-controls")).toBe("names-guided-results");
  await click("Controls");
  expect(host.querySelector("#names-guided-word")).toBe(field); expect(host.querySelector("#names-guided-controls")).toBe(controls); expect(host.querySelector("#names-guided-results")).toBe(results);
  expect(store().getSnapshot().data).toEqual(before);
});

it("keeps custom fields, current focus and active values through result updates and progressive disclosure", async () => {
  store().updateUi({ guided: { ...emptyGuidedUi(), words: [{ value: "cedar", candidateId: null }] } });
  await render();
  const custom = host.querySelector<HTMLInputElement>('[aria-label="Custom prefix 1"]')!, disclosure = custom.closest(".names-custom-disclosure")!;
  const summary = disclosure.querySelector<HTMLButtonElement>(":scope > button")!;
  await act(async () => summary.click()); custom.focus(); await input(custom, "Ultra");
  expect(host.querySelector('[aria-label="Custom prefix 1"]')).toBe(custom); expect(document.activeElement).toBe(custom); expect(disclosure.querySelector("dialog")!.open).toBe(true);
  expect(host.querySelector(".names-guided-preview-value")!.textContent).toBe("Ultracedar");
  expect(summary.textContent).toContain("1 active");
  await act(async () => disclosure.querySelector<HTMLButtonElement>("dialog header button")!.click()); await act(async () => summary.click());
  expect(custom.value).toBe("Ultra"); expect(store().getSnapshot().data.ui.guided!.customPrefixes).toEqual(["Ultra"]);
  await click("prefix Neo"); expect(host.querySelector(".names-guided-preview-value")!.textContent).toBe("Neocedar");
});

it("keeps the full long library name available inside its existing keyboard disclosure", async () => {
  const value = "A retained manual name that is long enough to wrap several lines while preserving every original character";
  store().addManual(value); const candidate = store().getSnapshot().data.candidates[0]!;
  await act(async () => root.render(<NameCandidateCard row candidate={candidate} compared={false} comparisonFull={false} onFavorite={() => {}} onSave={() => {}} onCompare={() => {}} onSeed={() => {}} onCreateBrand={() => {}} />));
  expect(host.querySelector("h3")!.getAttribute("title")).toBe(value);
  const disclosure = host.querySelector<HTMLElement>(".names-candidate-details")!, summary = disclosure.querySelector<HTMLButtonElement>(":scope > button")!;
  summary.focus(); await act(async () => summary.click());
  expect(disclosure.querySelector("dialog")!.open).toBe(true); expect(disclosure.querySelector("dialog")!.contains(document.activeElement)).toBe(true);
  expect(disclosure.querySelector(".names-full-value")!.textContent).toBe(`Full name${value}`);
  expect(store().getSnapshot().data.candidates[0]).toBe(candidate);
});
