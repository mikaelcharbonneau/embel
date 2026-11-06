// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualDirectionsView, type VisualDirectionCard, type VisualDirectionsViewProps } from "@/components/visual-directions/visual-directions-view";

let root: Root | null = null, host: HTMLDivElement;
const dialogMethods = { showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"), close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close") };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } },
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [method, descriptor] of Object.entries(dialogMethods)) { if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor); else Reflect.deleteProperty(HTMLDialogElement.prototype, method); }
});

const card = (id: string, overrides: Partial<VisualDirectionCard> = {}): VisualDirectionCard => ({
  id, title: `Direction ${id}`, summary: `Saved description ${id}`, preview: createElement("p", null, `Verified board ${id}`), onChoose: vi.fn(), ...overrides,
});
const props = (overrides: Partial<VisualDirectionsViewProps> = {}): VisualDirectionsViewProps => ({
  brandName: "Northline", logoPreview: createElement("p", null, "Chosen Northline logo"), backHref: "/brands/account/example/logo",
  cards: [null, null, null], generation: { status: "idle", completed: 0, onGenerate: vi.fn() }, ...overrides,
});
async function render(value: VisualDirectionsViewProps) { await act(async () => root!.render(createElement(VisualDirectionsView, value))); }
const button = (name: string) => [...host.querySelectorAll("button")].find(node => node.textContent?.trim() === name)!;
async function click(node: HTMLElement) { await act(async () => node.click()); }

describe("visual direction comparison", () => {
  it("starts only on a deliberate click, without showing a cost estimate", async () => {
    const value = props(); await render(value);
    expect(value.generation.onGenerate).not.toHaveBeenCalled();
    expect(host.querySelectorAll("article")).toHaveLength(3);
    expect(host.textContent).not.toMatch(/\$|estimat/i);
    const generate = button("Generate three directions");
    expect(generate.hasAttribute("aria-describedby")).toBe(false);
    await click(generate);
    expect(value.generation.onGenerate).toHaveBeenCalledTimes(1);
    expect(host.querySelector("dialog")?.open).toBe(false);
  });

  it("keeps completed boards visible and prevents a second request while the original is uncertain", async () => {
    const onGenerate = vi.fn(), onCheck = vi.fn(), onStop = vi.fn();
    await render(props({ cards: [card("A"), card("B"), null], generation: { status: "uncertain", completed: 2, onGenerate, onCheck, onStop } }));
    expect(host.textContent).toContain("Verified board A"); expect(host.textContent).toContain("Verified board B");
    expect(host.textContent).toContain("2 of 3 ready"); expect(host.textContent).not.toMatch(/estimat/i);
    expect(button("Checking request…").disabled).toBe(true);
    await click(button("Checking request…")); await click(button("Check progress")); await click(button("Stop generation"));
    expect(onGenerate).not.toHaveBeenCalled(); expect(onCheck).toHaveBeenCalledTimes(1); expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows an incomplete set without fabricating its missing board or selecting a result automatically", async () => {
    const saved = card("A");
    await render(props({ cards: [saved, null, null], generation: { status: "partial", completed: 1, onGenerate: vi.fn() } }));
    expect(host.textContent).toContain("1 of 3 ready"); expect(host.textContent).toContain("This set is incomplete");
    expect(host.querySelectorAll("[data-selected='true']")).toHaveLength(0);
    expect(host.textContent?.match(/No board saved for this direction/g)).toHaveLength(2);
    expect(saved.onChoose).not.toHaveBeenCalled();
    await click(button("Choose direction"));
    expect(saved.onChoose).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("[data-selected='true']")).toHaveLength(0);
  });

  it("renders selection only from saved state and does not offer an earlier board as current", async () => {
    const stale = card("A", { selected: true, stale: true }), current = card("B", { selected: true });
    await render(props({ cards: [stale, current, null], selectionStatus: "Direction saved.", finalAction: createElement("a", { href: "/kit" }, "View brand assets") }));
    const articles = host.querySelectorAll("article");
    expect(articles[0]!.dataset.selected).toBe("false"); expect(articles[0]!.textContent).toContain("Earlier inputs");
    expect([...articles[0]!.querySelectorAll("button")].find(node => node.textContent === "Choose direction")?.disabled).toBe(true);
    expect(articles[1]!.dataset.selected).toBe("true"); expect(button("Chosen direction").disabled).toBe(true);
    expect(host.textContent).toContain("Direction saved."); expect(host.querySelector('a[href="/kit"]')?.textContent).toBe("View brand assets");
  });

  it("stops offering progress checks on completion and puts a confirmed kit before the comparison", async () => {
    const cards = [card("A"), card("B"), card("C")] as const;
    const generation = { status: "complete" as const, completed: 3, onCheck: vi.fn(), onGenerate: vi.fn() };
    await render(props({ cards, generation }));
    expect(button("Check progress")).toBeUndefined();
    expect(host.textContent).toContain("3 of 3 ready");
    expect(host.textContent).not.toContain("View brand assets");

    // The current choice can belong to an earlier set than the three being compared.
    await render(props({ cards, generation, finalAction: createElement("a", { href: "/kit" }, "View brand assets") }));
    const link = host.querySelector('a[href="/kit"]')!;
    expect(link.compareDocumentPosition(host.querySelector("article")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button("Generate another set").disabled).toBe(false);
    expect(generation.onGenerate).not.toHaveBeenCalled();
  });

  it("opens a larger board without choosing it and returns keyboard focus on close", async () => {
    const saved = card("A"); await render(props({ cards: [saved, null, null] }));
    const trigger = host.querySelector<HTMLButtonElement>("[aria-label='View Direction A larger']")!;
    trigger.focus(); await click(trigger);
    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(true); expect(dialog.textContent).toContain("Verified board A"); expect(saved.onChoose).not.toHaveBeenCalled();
    await click(host.querySelector<HTMLButtonElement>("[aria-label='Close larger preview']")!);
    expect(dialog.open).toBe(false); expect(document.activeElement).toBe(trigger);
  });

  it("clears an expanded private preview when its board leaves the current comparison", async () => {
    const initial = props({ cards: [card("A"), null, null] }); await render(initial);
    await click(host.querySelector<HTMLButtonElement>("[aria-label='View Direction A larger']")!);
    await render(props());
    expect(host.querySelector("dialog")!.open).toBe(false); expect(host.textContent).not.toContain("Verified board A");
    await render(initial);
    expect(host.querySelector("dialog")!.open).toBe(false);
  });

  it("keeps disabled generation and selection reasons available without relying on hover", async () => {
    const saved = card("A", { disabledReason: "Your logo choice is still saving." });
    const onCheck = vi.fn();
    await render(props({ cards: [saved, null, null], generation: { status: "idle", completed: 0, disabledReason: "Choose a saved logo first.", onGenerate: vi.fn(), onCheck } }));
    expect(button("Generate three directions").disabled).toBe(true); expect(button("Choose direction").disabled).toBe(true);
    expect(host.textContent).toContain("Choose a saved logo first."); expect(host.textContent).toContain("Your logo choice is still saving.");
    await click(button("Choose direction")); expect(saved.onChoose).not.toHaveBeenCalled();
    await click(button("Check availability")); expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it("offers a read-only saved-choice recovery action while keeping unavailable choices disabled", async () => {
    const onCheck = vi.fn(), onGenerate = vi.fn(), saved = card("A", {
      disabledReason: "Saving your direction is temporarily unavailable. Your boards are saved.",
    });
    const value = props({ cards: [saved, null, null], generation: { status: "complete", completed: 1, onGenerate }, selectionCheck: { busy: false, onCheck } });
    await render(value);
    expect(button("Choose direction").disabled).toBe(true);
    expect(host.textContent).not.toContain("Checking your saved choice…");
    await click(button("Check saved choice"));
    expect(onCheck).toHaveBeenCalledTimes(1); expect(onGenerate).not.toHaveBeenCalled(); expect(saved.onChoose).not.toHaveBeenCalled();
    await render({ ...value, selectionCheck: { busy: true, onCheck } });
    expect(button("Checking saved choice…").disabled).toBe(true);
    await click(button("Checking saved choice…")); expect(onCheck).toHaveBeenCalledTimes(1);
  });
});
