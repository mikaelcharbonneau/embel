// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspirationView } from "@/components/inspiration/inspiration-workspace";
import type { InspirationController } from "@/components/inspiration/use-inspiration";
import { inspirationBrands, INSPIRATION_CATALOG_VERSION } from "@/domain/inspiration";

// The gallery uses public brand imagery. No account, provider or network calls.
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: vi.fn(), AccountStatus: () => null }));
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const [first, second] = inspirationBrands;
let host: HTMLDivElement, root: Root, width: number, controller: InspirationController;
const observers = new Set<TestResizeObserver>();
class TestResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    observers.delete(this);
  }
}
const brandCards = () => [...host.querySelectorAll<HTMLElement>(".inspiration-brand")];
const partCards = () => [...host.querySelectorAll<HTMLElement>(".inspiration-card")];
const images = () => [...host.querySelectorAll<HTMLImageElement>(".inspiration-card img")];
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
async function render(variant: "page" | "conversation" = "page") {
  await act(async () =>
    root.render(<InspirationView controller={controller} projectId={projectId} variant={variant} />),
  );
}
async function click(text: string) {
  await act(async () => [...host.querySelectorAll("button")].find((item) => item.textContent === text)!.click());
}
async function resize(value: number) {
  width = value;
  await act(async () => {
    for (const observer of [...observers])
      observer.callback(
        [...observer.targets].map(
          (target) =>
            ({
              target,
              contentRect: new DOMRect(0, 0, width, 0),
            }) as ResizeObserverEntry,
        ),
        observer as unknown as ResizeObserver,
      );
  });
}
function expectSameNodes(actual: Element[], expected: Element[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((node, index) => expect(node).toBe(expected[index]));
}
const choice = (
  referenceId: string,
  ensemble: boolean,
  elements: ("logo" | "colors" | "typography" | "composition" | "images")[],
) => ({ ownerId, projectId, referenceId, ensemble, elements, revision: 1, updatedAt: "2026-11-08T10:00:00Z" });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  width = 1250;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("inspiration-columns"))
      return new DOMRect(0, 0, width, Number.parseFloat(this.style.height) || 0);
    if (this.classList.contains("inspiration-card")) {
      const image = this.querySelector("img")!;
      const cardWidth = Number.parseFloat(this.parentElement!.style.getPropertyValue("--inspiration-card-width"));
      // Intrinsic artwork plus the caption. CSS geometry is browser QA.
      return new DOMRect(0, 0, cardWidth, image ? (cardWidth * image.height) / image.width + 30 : 200);
    }
    return new DOMRect();
  });
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
  controller = {
    overview: {
      ownerId,
      projectId,
      projectTitle: "Local fixture",
      projectScope: "complete_brand",
      projectRevision: 1,
      catalogVersion: INSPIRATION_CATALOG_VERSION,
      selectionRevision: 0,
      choices: [],
      availableReferenceIds: inspirationBrands.map((brand) => brand.id),
    },
    intents: new Map(),
    busy: new Set(),
    loading: false,
    blocked: false,
    error: null,
    canSave: true,
    refresh: vi.fn(),
    save: vi.fn(),
    check: vi.fn(),
    keepSaved: vi.fn(),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("Inspiration brands", () => {
  it("shows Brands first, as one container per brand holding one container per image, inside the conversation", async () => {
    await render("conversation");
    const message = host.querySelector("article.guided-assistant-message.inspiration-browse")!;
    expect(message).not.toBeNull();
    expect(host.querySelector("h1")).toBeNull();
    expect(
      [...host.querySelectorAll(".inspiration-categories button")].map((item) => [
        item.textContent,
        item.getAttribute("aria-pressed"),
      ]),
    ).toEqual([
      ["Brands", "true"],
      ["Logos", "false"],
      ["Colors", "false"],
      ["Typefaces", "false"],
      ["Socials", "false"],
      ["Visuals", "false"],
    ]);
    expect(brandCards()).toHaveLength(Math.min(8, inspirationBrands.length));
    const card = brandCards()[0]!;
    expect(card.getAttribute("aria-label")).toBe(first!.brand);
    expect([...card.querySelectorAll<HTMLElement>(".inspiration-brand-tile")].map((tile) => tile.dataset.part)).toEqual(
      ["logo", "colors", "typefaces", "socials", "visuals"],
    );
    expect([...card.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual(
      first!.parts.map((part) => part.thumbnail),
    );
    expect(host.querySelector(".inspiration-continue-inline a")?.getAttribute("href")).toBe(
      `/brands/account/${projectId}/logo`,
    );
    expect(host.querySelector(".inspiration-card")).toBeNull();
  });

  it("likes the whole brand or one of its parts, each as its own change to the brand's choice", async () => {
    await render();
    await act(async () => button(`Like the whole ${first!.brand} brand`).click());
    expect(controller.save).toHaveBeenLastCalledWith(first!.id, { ensemble: true, elements: [] });
    await act(async () => button(`Like ${first!.brand} colors`).click());
    expect(controller.save).toHaveBeenLastCalledWith(first!.id, { ensemble: false, elements: ["colors"] });
    controller = {
      ...controller,
      overview: {
        ...controller.overview!,
        selectionRevision: 1,
        choices: [choice(first!.id, true, ["colors", "images"])],
      },
    };
    await render();
    await act(async () => button(`Unlike ${first!.brand} colors`).click());
    expect(controller.save).toHaveBeenLastCalledWith(first!.id, { ensemble: true, elements: ["images"] });
    // Clicking a heart never opens the brand.
    expect(host.querySelector("dialog")).toBeNull();
  });

  it("counts the whole brand and each liked part, and Liked shows only brands with a like", async () => {
    controller.overview!.choices = [
      choice(first!.id, true, ["logo", "typography"]),
      choice(second!.id, false, ["images"]),
    ];
    await render();
    expect(host.querySelector(".inspiration-views")?.textContent).toContain("Liked · 4");
    await click("Liked · 4");
    expect(brandCards().map((card) => card.getAttribute("aria-label"))).toEqual([first!.brand, second!.brand]);
    await click("Visuals");
    expect(partCards().map((card) => card.getAttribute("aria-label"))).toEqual([`${second!.brand} visuals`]);
    await click("Colors");
    expect(host.querySelector(".inspiration-empty h2")?.textContent).toBe("Start with a few likes");
    expect(controller.save).not.toHaveBeenCalled();
  });

  it("shows one part across brands in a category, more on request, and likes that part from its card", async () => {
    await render();
    await click("Typefaces");
    expect(brandCards()).toHaveLength(0);
    expect(partCards()).toHaveLength(Math.min(18, inspirationBrands.length));
    expect(images()[0]!.getAttribute("src")).toBe(first!.parts.find((part) => part.part === "typefaces")!.thumbnail);
    if (inspirationBrands.length > 18) {
      await click("Show more typefaces");
      expect(partCards()).toHaveLength(Math.min(36, inspirationBrands.length));
    }
    await act(async () => button(`Like ${first!.brand} typefaces`).click());
    expect(controller.save).toHaveBeenLastCalledWith(first!.id, { ensemble: false, elements: ["typography"] });
  });

  it("finds brands by name and keeps the search when switching categories", async () => {
    await render();
    const input = host.querySelector<HTMLInputElement>(".inspiration-search input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, second!.brand);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(brandCards().map((card) => card.getAttribute("aria-label"))).toContain(second!.brand);
    expect(brandCards().map((card) => card.getAttribute("aria-label"))).not.toContain(first!.brand);
    await click("Logos");
    expect(partCards().map((card) => card.getAttribute("aria-label"))).toContain(`${second!.brand} logo`);
  });

  it("keeps brands browseable but not likeable until their catalog rows are installed", async () => {
    controller.overview!.availableReferenceIds = [];
    await render();
    const card = brandCards()[0]!;
    expect(card.querySelector<HTMLButtonElement>(".inspiration-brand-like")!.disabled).toBe(true);
    expect(
      [...card.querySelectorAll<HTMLButtonElement>(".inspiration-part-like")].every((heart) => heart.disabled),
    ).toBe(true);
    expect(card.querySelector(".inspiration-availability")?.textContent).toBe("Browse only for now");
    await act(async () => button(`Open ${first!.brand}: logo`).click());
    expect(host.querySelector("dialog")?.textContent).toContain(
      "You can browse this brand now. Liking it will be available soon.",
    );
  });
});

describe("Add your own references", () => {
  it("shows your own images above the button, counts their likes, and keeps them in Liked", async () => {
    const pick = vi.fn(),
      section = vi.fn((likedOnly: boolean) => <article aria-label="Your images" data-liked-only={String(likedOnly)} />);
    const references = {
      action: (
        <button type="button" className="inspiration-footer-link" onClick={pick}>
          Add your own references
        </button>
      ),
      status: <p role="status">Image added.</p>,
      liked: 2,
      revision: 3,
      section,
    };
    await act(async () =>
      root.render(
        <InspirationView
          controller={controller}
          projectId={projectId}
          variant="conversation"
          references={references}
        />,
      ),
    );
    expect(host.querySelector(".inspiration-views")?.textContent).toContain("Liked · 2");
    const yours = host.querySelector('[aria-label="Your images"]')!;
    expect(yours.getAttribute("data-liked-only")).toBe("false");
    // Right above the footer and its button, so new images appear where you added them.
    expect(yours.closest(".inspiration-yours-slot")?.nextElementSibling?.classList.contains("inspiration-footer")).toBe(
      true,
    );
    await click("Add your own references");
    expect(pick).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Image added.");
    await click("Liked · 2");
    expect(host.querySelector('[aria-label="Your images"]')?.getAttribute("data-liked-only")).toBe("true");
    expect(host.querySelector(".inspiration-empty")).toBeNull();
    expect(host.querySelector("dialog")).toBeNull();
    expect(controller.save).not.toHaveBeenCalled();
  });
});

describe("Brand bento", () => {
  it("places brand containers side by side once the gallery width is known, keeping each card mounted", async () => {
    await render();
    const before = brandCards();
    expect(before[0]!.style.position).toBe("");
    await resize(747);
    const grid = host.querySelector<HTMLElement>(".inspiration-brands")!;
    expect(grid.dataset.positioned).toBe("true");
    expectSameNodes(brandCards(), before);
    const boxes = brandCards().map((card) => ({
      left: Number.parseFloat(card.style.left),
      top: Number.parseFloat(card.style.top),
      width: Number.parseFloat(card.style.width),
      height: Number.parseFloat(card.style.height),
    }));
    expect(boxes.every((box) => box.width > 0 && box.height > 0)).toBe(true);
    const firstRow = boxes.filter((box) => box.top === 0);
    expect(firstRow.length).toBeGreaterThan(1);
    expect(firstRow.reduce((total, box) => total + box.width, 0) + 12 * (firstRow.length - 1)).toBe(747);
    // Inside a card, every image keeps its own proportions.
    const tile = brandCards()[0]!.querySelector<HTMLElement>(".inspiration-brand-tile")!;
    expect(tile.style.aspectRatio.replace(/\s/g, "")).toBe(`${first!.parts[0]!.width}/${first!.parts[0]!.height}`);
  });
});

describe("Brand overlay", () => {
  it("opens from a brand container at the clicked image, steps through all five and saves likes from inside", async () => {
    await render();
    const trigger = button(`Open ${first!.brand}: typefaces`);
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("h2")?.textContent).toBe(first!.brand);
    const large = () => dialog.querySelector<HTMLImageElement>(".inspiration-overlay-art img")!;
    expect(large().getAttribute("src")).toBe(first!.parts[2]!.image);
    expect(dialog.querySelector("figcaption")?.textContent).toBe("Typefaces · 3 of 5");
    await act(async () => button("Next image").click());
    expect(large().getAttribute("src")).toBe(first!.parts[3]!.image);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(large().getAttribute("src")).toBe(first!.parts[0]!.image);
    expect(dialog.querySelectorAll(".inspiration-overlay-parts li")).toHaveLength(5);
    await act(async () => dialog.querySelector<HTMLButtonElement>(".inspiration-overall")!.click());
    expect(controller.save).toHaveBeenLastCalledWith(first!.id, { ensemble: true, elements: [] });
    await act(async () =>
      dialog.querySelector<HTMLButtonElement>(`button[aria-label="Like ${first!.brand} socials"]`)!.click(),
    );
    expect(controller.save).toHaveBeenLastCalledWith(first!.id, { ensemble: false, elements: ["composition"] });
    await act(async () => button("Close brand").click());
    expect(host.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens when the container itself is clicked, and closes only outside the dialog", async () => {
    await render();
    await act(async () => brandCards()[0]!.click());
    const dialog = host.querySelector("dialog")!;
    expect(dialog.querySelector<HTMLImageElement>(".inspiration-overlay-art img")!.getAttribute("src")).toBe(
      first!.parts[0]!.image,
    );
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 30, 350, 500));
    await act(async () => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 22, clientY: 32 })));
    expect(host.querySelector("dialog")).toBe(dialog);
    await act(async () => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 19, clientY: 32 })));
    expect(host.querySelector("dialog")).toBeNull();
    expect(controller.save).not.toHaveBeenCalled();
  });
});

describe("Part grid masonry", () => {
  it("keeps every card, image and focused control mounted across width breakpoints", async () => {
    await render();
    await click("Logos");
    const grid = host.querySelector<HTMLElement>(".inspiration-columns")!,
      originalCards = partCards(),
      originalImages = images();
    const control =
      originalCards[Math.min(6, originalCards.length - 1)]!.querySelector<HTMLButtonElement>(".inspiration-caption")!;
    control.focus();
    for (const [nextWidth, columns] of [
      [1250, 5],
      [950, 4],
      [700, 3],
      [400, 2],
      [320, 1],
      [1250, 5],
    ]) {
      await resize(nextWidth!);
      expectSameNodes(partCards(), originalCards);
      expectSameNodes(images(), originalImages);
      expect(document.activeElement).toBe(control);
      const cardWidth = (nextWidth! - (columns! - 1) * 16) / columns!;
      const heights = Array<number>(columns!).fill(0);
      partCards().forEach((card, index) => {
        const column = index % columns!;
        expect(Number.parseFloat(card.style.left)).toBeCloseTo(column * (cardWidth + 16));
        expect(Number.parseFloat(card.style.top)).toBeCloseTo(heights[column]!);
        heights[column]! += card.getBoundingClientRect().height + 20;
      });
      expect(Number.parseFloat(grid.style.height)).toBeCloseTo(Math.max(...heights) - 20);
    }
  });
});
