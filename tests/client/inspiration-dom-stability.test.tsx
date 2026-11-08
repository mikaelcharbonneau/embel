// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspirationView } from "@/components/inspiration/inspiration-workspace";
import type { InspirationController } from "@/components/inspiration/use-inspiration";
import { inspirationCatalog, INSPIRATION_CATALOG_VERSION } from "@/domain/inspiration";

// The gallery uses public catalog imagery. No account, provider or network calls.
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: vi.fn(), AccountStatus: () => null }));
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let host: HTMLDivElement, root: Root, width: number, controller: InspirationController;
const observers = new Set<TestResizeObserver>();
class TestResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { observers.delete(this); }
}
const cards = () => [...host.querySelectorAll<HTMLElement>(".inspiration-card")];
const images = () => [...host.querySelectorAll<HTMLImageElement>(".inspiration-card .inspiration-image")];
async function render() { await act(async () => root.render(<InspirationView controller={controller} projectId={projectId} />)); }
async function resize(value: number) {
  width = value;
  await act(async () => {
    for (const observer of [...observers]) observer.callback([...observer.targets].map(target => ({
      target, contentRect: new DOMRect(0, 0, width, 0),
    } as ResizeObserverEntry)), observer as unknown as ResizeObserver);
  });
}
function expectSameNodes(actual: Element[], expected: Element[]) {
  expect(actual).toHaveLength(expected.length); actual.forEach((node, index) => expect(node).toBe(expected[index]));
}
async function click(text: string) {
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === text)!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("ResizeObserver", TestResizeObserver); width = 1250;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("inspiration-columns")) return new DOMRect(0, 0, width, Number.parseFloat(this.style.height) || 0);
    if (this.classList.contains("inspiration-card")) {
      const image = this.querySelector("img")!;
      const cardWidth = Number.parseFloat(this.parentElement!.style.getPropertyValue("--inspiration-card-width"));
      // Intrinsic artwork plus the existing caption. CSS geometry is browser QA.
      return new DOMRect(0, 0, cardWidth, image ? cardWidth * image.height / image.width + 49 : 200);
    }
    return new DOMRect();
  });
  controller = {
    overview: { ownerId, projectId, projectTitle: "Local fixture", projectScope: "complete_brand", projectRevision: 1,
      catalogVersion: INSPIRATION_CATALOG_VERSION, selectionRevision: 0, choices: [] },
    intents: new Map(), busy: new Set(), loading: false, blocked: false, error: null, canSave: true,
    refresh: vi.fn(), save: vi.fn(), check: vi.fn(), keepSaved: vi.fn(),
  };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); observers.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("Inspiration stable masonry parentage", () => {
  it("counts retained liked references against the full catalog, not only discovery designs", async () => {
    controller.overview!.choices = inspirationCatalog.map(design => ({
      ownerId, projectId, referenceId: design.id, ensemble: true, elements: [], revision: 1, updatedAt: "2026-10-25T10:00:00Z",
    }));
    await render();
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("Liked"))!.click());
    expect(cards()).toHaveLength(30);
    expect(host.querySelector(".inspiration-footer")?.textContent).toContain("30 of 30 curated designs");
    expect(controller.save).not.toHaveBeenCalled();
  });

  it("explains catalog-gated likes without blocking inspection or enabling uninstalled references", async () => {
    await render();
    const pending = inspirationCatalog.find(design => design.availableSince)!;
    const card = cards().find(item => item.getAttribute("aria-label") === `${pending.brand} — ${pending.slug}`)!;
    const heart = card.querySelector<HTMLButtonElement>(".inspiration-heart")!;
    expect(heart.disabled).toBe(true);
    expect(heart.title).toBe("You can browse this design now. Liking it will be available soon.");
    expect(card.querySelector(".inspiration-availability")?.textContent).toBe("Browse only for now");
    expect(heart.getAttribute("aria-describedby")).toBe(card.querySelector(".inspiration-availability")?.id);
    expect(card.querySelector<HTMLButtonElement>(".inspiration-caption")!.disabled).toBe(false);
    controller.overview!.availableReferenceIds = inspirationCatalog.map(design => design.id);
    await render();
    expect(card.querySelector<HTMLButtonElement>(".inspiration-heart")!.disabled).toBe(false);
    expect(card.querySelector(".inspiration-availability")).toBeNull();
    expect(heart.getAttribute("aria-describedby")).toBeNull();
    expect(controller.save).not.toHaveBeenCalled();
  });

  it("keeps every image, card and focused control mounted across all existing width breakpoints", async () => {
    await render();
    const grid = host.querySelector<HTMLElement>(".inspiration-columns")!, originalCards = cards(), originalImages = images();
    const control = originalCards[6]!.querySelector<HTMLButtonElement>(".inspiration-caption")!; control.focus();
    expect(originalCards.length).toBeGreaterThan(15);
    for (const [nextWidth, columns] of [[1250, 5], [950, 4], [700, 3], [400, 2], [320, 1], [1250, 5]]) {
      await resize(nextWidth!);
      expectSameNodes(cards(), originalCards); expectSameNodes(images(), originalImages); expect(document.activeElement).toBe(control);
      expect(originalCards.every(card => card.parentElement === grid)).toBe(true);
      const cardWidth = (nextWidth! - (columns! - 1) * 16) / columns!;
      const heights = Array<number>(columns!).fill(0);
      cards().forEach((card, index) => {
        const column = index % columns!;
        expect(Number.parseFloat(card.style.left)).toBeCloseTo(column * (cardWidth + 16));
        expect(Number.parseFloat(card.style.top)).toBeCloseTo(heights[column]!);
        heights[column]! += card.getBoundingClientRect().height + 20;
      });
      expect(Number.parseFloat(grid.style.height)).toBeCloseTo(Math.max(...heights) - 20);
    }
  });

  it("retains surviving filtered cards and image failure state instead of remounting them in new columns", async () => {
    await render();
    const originals = new Map(cards().map(card => [card.getAttribute("aria-label"), card]));
    const design = inspirationCatalog.find(item => item.kind === "logo")!;
    const card = originals.get(`${design.brand} — ${design.slug}`)!;
    const failed = card.querySelector("img")!;
    await act(async () => failed.dispatchEvent(new Event("error")));
    const fallback = card.querySelector(".inspiration-image-error"); expect(fallback).not.toBeNull();
    await click("Logos");
    expect(cards().length).toBeLessThan(originals.size);
    for (const survivor of cards()) expect(survivor).toBe(originals.get(survivor.getAttribute("aria-label")));
    expect(card.querySelector(".inspiration-image-error")).toBe(fallback);
    await resize(400); await click("All");
    expect(cards().find(item => item.getAttribute("aria-label") === `${design.brand} — ${design.slug}`)).toBe(card);
    expect(card.querySelector(".inspiration-image-error")).toBe(fallback);
    expect(controller.save).not.toHaveBeenCalled();
  });

  it("keeps imagery and source order while saved-choice checks rerender the gallery", async () => {
    await render(); const originalImages = images(), originalCards = cards();
    controller = { ...controller, loading: true, canSave: false }; await render();
    expectSameNodes(images(), originalImages); expectSameNodes(cards(), originalCards);
    controller = { ...controller, loading: false, canSave: true, overview: structuredClone(controller.overview) }; await render();
    expectSameNodes(images(), originalImages); expectSameNodes(cards(), originalCards);
    expect(cards().map(card => card.getAttribute("aria-label"))).toEqual(originalCards.map(card => card.getAttribute("aria-label")));

  });

  it("repositions each column after image-height changes and disconnects replaced or unmounted observers", async () => {
    await render();
    const grid = host.querySelector<HTMLElement>(".inspiration-columns")!, originalImages = images(), originalCards = cards();
    const observer = [...observers][0]!, before = Number.parseFloat(originalCards[5]!.style.top), other = originalCards[6]!.style.top;
    const oldHeight = originalCards[0]!.getBoundingClientRect().height;
    originalImages[0]!.height += 200;
    await resize(width);
    const change = originalCards[0]!.getBoundingClientRect().height - oldHeight;
    expect(Number.parseFloat(originalCards[5]!.style.top)).toBeCloseTo(before + change);
    expect(originalCards[6]!.style.top).toBe(other); expectSameNodes(images(), originalImages);
    const bottom = Math.max(...originalCards.map(card => Number.parseFloat(card.style.top) + card.getBoundingClientRect().height));
    expect(Number.parseFloat(grid.style.height)).toBeCloseTo(bottom);
    controller = { ...controller, loading: true }; await render();
    expect(observers.has(observer)).toBe(false); expect(observers.size).toBe(1);
    await act(async () => root.render(null)); expect(observers.size).toBe(0);
  });
});

it("keeps reference detail open on padding and closes only outside without saving choices", async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } },
  });
  await render();
  const trigger = cards()[0]!.querySelector<HTMLButtonElement>(".inspiration-caption")!;
  trigger.focus(); await act(async () => trigger.click());
  const dialog = host.querySelector("dialog")!;
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 30, 350, 500));
  await act(async () => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 22, clientY: 32 })));
  expect(dialog.open).toBe(true); expect(host.querySelector("dialog")).toBe(dialog);
  await act(async () => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 19, clientY: 32 })));
  expect(host.querySelector("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
  expect(controller.save).not.toHaveBeenCalled();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
