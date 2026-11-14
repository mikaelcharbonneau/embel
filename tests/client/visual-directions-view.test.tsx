// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSlotContext } from "@/components/workspace/workspace-slots";
import {
  ChosenBrandView,
  VisualDirectionsView,
  type VisualDirectionCard,
  type VisualDirectionsViewProps,
} from "@/components/visual-directions/visual-directions-view";

let root: Root | null = null,
  host: HTMLDivElement;
const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [method, descriptor] of Object.entries(dialogMethods)) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
  }
});

const card = (id: string, overrides: Partial<VisualDirectionCard> = {}): VisualDirectionCard => ({
  id,
  title: `Direction ${id}`,
  summary: `Saved description ${id}`,
  preview: createElement("p", null, `Verified board ${id}`),
  onChoose: vi.fn(),
  ...overrides,
});
const props = (overrides: Partial<VisualDirectionsViewProps> = {}): VisualDirectionsViewProps => ({
  brandName: "Northline",
  logoPreview: createElement("p", null, "Chosen Northline logo"),
  backHref: "/brands/account/example/logo",
  cards: [null, null, null],
  generation: { status: "idle", completed: 0, onGenerate: vi.fn() },
  ...overrides,
});
async function render(value: VisualDirectionsViewProps) {
  await act(async () => root!.render(createElement(VisualDirectionsView, value)));
}
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === name)!;
async function click(node: HTMLElement) {
  await act(async () => node.click());
}

// Each board has a real Choose button (decision 10); the chosen card is marked by its ring (data-selected) only.
const choice = (index = 0) =>
  [...document.querySelectorAll<HTMLElement>("article")][index]!.querySelector<HTMLButtonElement>(
    "button[aria-pressed]",
  )!;

describe("visual direction comparison", () => {
  it("starts only on a deliberate click, without showing a cost estimate", async () => {
    const value = props();
    await render(value);
    expect(value.generation.onGenerate).not.toHaveBeenCalled();
    expect(host.querySelectorAll("article")).toHaveLength(3);
    expect(host.textContent).not.toMatch(/\$|estimat/i);
    const generate = button("Create three directions");
    expect(generate.hasAttribute("aria-describedby")).toBe(false);
    await click(generate);
    expect(value.generation.onGenerate).toHaveBeenCalledTimes(1);
    expect(host.querySelector("dialog")).toBeNull();
  });

  it("keeps completed boards visible and prevents a second request while the original is uncertain", async () => {
    const onGenerate = vi.fn(),
      onCheck = vi.fn(),
      onStop = vi.fn();
    await render(
      props({
        cards: [card("A"), card("B"), null],
        generation: { status: "uncertain", completed: 2, onGenerate, onCheck, onStop },
      }),
    );
    expect(host.textContent).toContain("Verified board A");
    expect(host.textContent).toContain("Verified board B");
    expect(host.textContent).toContain("2 of 3 ready");
    expect(host.textContent).not.toMatch(/estimat/i);
    expect(button("Checking request…").disabled).toBe(true);
    await click(button("Checking request…"));
    await click(button("Check progress"));
    await click(button("Stop generation"));
    expect(onGenerate).not.toHaveBeenCalled();
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows an incomplete set without fabricating its missing board or selecting a result automatically", async () => {
    const saved = card("A");
    await render(
      props({ cards: [saved, null, null], generation: { status: "partial", completed: 1, onGenerate: vi.fn() } }),
    );
    expect(host.textContent).toContain("1 of 3 ready");
    expect(host.textContent).toContain("This set is incomplete");
    expect(host.querySelectorAll("[data-selected='true']")).toHaveLength(0);
    expect(host.textContent?.match(/No board saved for this direction/g)).toHaveLength(2);
    expect(saved.onChoose).not.toHaveBeenCalled();
    await click(choice(0));
    expect(saved.onChoose).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("[data-selected='true']")).toHaveLength(0);
  });

  it("renders selection only from saved state and does not offer an earlier board as current", async () => {
    const stale = card("A", { selected: true, stale: true }),
      current = card("B", { selected: true });
    await render(
      props({
        cards: [stale, current, null],
        selectionStatus: "Direction saved.",
        finalAction: createElement("a", { href: "/kit" }, "View brand assets"),
      }),
    );
    const articles = host.querySelectorAll("article");
    expect(articles[0]!.hasAttribute("data-selected")).toBe(false);
    expect(articles[0]!.textContent).toContain("This board uses earlier inputs.");
    expect(choice(0).disabled).toBe(true);
    expect(choice(0).getAttribute("aria-pressed")).toBe("false");
    expect(articles[1]!.dataset.selected).toBe("true");
    expect(choice(1).getAttribute("aria-pressed")).toBe("true");
    expect(choice(1).textContent).toBe("Chosen");
    expect(host.textContent).toContain("Direction saved.");
    expect(host.querySelector('a[href="/kit"]')?.textContent).toBe("View brand assets");
  });

  it("stops offering progress checks on completion and closes the step with Continue after the comparison", async () => {
    const cards = [card("A"), card("B"), card("C")] as const;
    const generation = { status: "complete" as const, completed: 3, onCheck: vi.fn(), onGenerate: vi.fn() };
    await render(props({ cards, generation }));
    expect(button("Check progress")).toBeUndefined();
    expect(host.textContent).toContain("3 of 3 ready");
    expect(host.textContent).not.toContain("View brand assets");

    // The current choice can belong to an earlier set than the three being compared.
    await render(props({ cards, generation, finalAction: createElement("a", { href: "/kit" }, "View brand assets") }));
    const link = host.querySelector('a[href="/kit"]')!;
    expect(
      link.compareDocumentPosition(host.querySelector("article")!) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(button("More directions").disabled).toBe(false);
    expect(generation.onGenerate).not.toHaveBeenCalled();
  });

  it("opens a larger board without choosing it and returns keyboard focus on close", async () => {
    const saved = card("A");
    await render(props({ cards: [saved, null, null] }));
    const trigger = host.querySelector<HTMLButtonElement>("[aria-label='Enlarge Direction 1, Direction A']")!;
    trigger.focus();
    await click(trigger);
    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("Verified board A");
    expect(dialog.textContent).toContain("Direction 1 of 3");
    expect(saved.onChoose).not.toHaveBeenCalled();
    await click(dialog.querySelector<HTMLButtonElement>("[aria-label='Close']")!);
    expect(host.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("clears an expanded private preview when its board leaves the current comparison", async () => {
    const initial = props({ cards: [card("A"), null, null] });
    await render(initial);
    await click(host.querySelector<HTMLButtonElement>("[aria-label='Enlarge Direction 1, Direction A']")!);
    expect(host.querySelector("dialog")).not.toBeNull();
    await render(props());
    expect(host.querySelector("dialog")).toBeNull();
    expect(host.textContent).not.toContain("Verified board A");
    await render(initial);
    expect(host.querySelector("dialog")).toBeNull();
  });

  it("keeps disabled generation and selection reasons available without relying on hover", async () => {
    const saved = card("A", { disabledReason: "Your logo choice is still saving." });
    const onCheck = vi.fn();
    await render(
      props({
        cards: [saved, null, null],
        generation: {
          status: "idle",
          completed: 0,
          disabledReason: "Choose a saved logo first.",
          onGenerate: vi.fn(),
          onCheck,
        },
      }),
    );
    expect(button("Create three directions").disabled).toBe(true);
    expect(choice(0).disabled).toBe(true);
    expect(host.textContent).toContain("Choose a saved logo first.");
    expect(host.textContent).toContain("Your logo choice is still saving.");
    await click(choice(0));
    expect(saved.onChoose).not.toHaveBeenCalled();
    await click(button("Check availability"));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it("offers a read-only saved-choice recovery action while keeping unavailable choices disabled", async () => {
    const onCheck = vi.fn(),
      onGenerate = vi.fn(),
      saved = card("A", {
        disabledReason: "Saving your direction is temporarily unavailable. Your boards are saved.",
      });
    const value = props({
      cards: [saved, null, null],
      generation: { status: "complete", completed: 1, onGenerate },
      selectionCheck: { busy: false, onCheck },
    });
    await render(value);
    expect(choice(0).disabled).toBe(true);
    expect(host.textContent).not.toContain("Checking your saved choice…");
    await click(button("Check saved choice"));
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onGenerate).not.toHaveBeenCalled();
    expect(saved.onChoose).not.toHaveBeenCalled();
    await render({ ...value, selectionCheck: { busy: true, onCheck } });
    expect(button("Checking saved choice…").disabled).toBe(true);
    await click(button("Checking saved choice…"));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it("moves through the boards in the larger view and chooses from it", async () => {
    const a = card("A"),
      c = card("C");
    await render(props({ cards: [a, null, c], generation: { status: "partial", completed: 2, onGenerate: vi.fn() } }));
    await click(host.querySelector<HTMLButtonElement>("[aria-label='Enlarge Direction 1, Direction A']")!);
    const dialog = () => host.querySelector("dialog")!;
    await click(button("Next"));
    expect(dialog().textContent).toContain("Direction 3 of 3");
    expect(dialog().textContent).toContain("Verified board C");
    await click(button("Choose this direction"));
    expect(c.onChoose).toHaveBeenCalledTimes(1);
    expect(a.onChoose).not.toHaveBeenCalled();
    expect(host.querySelector("dialog")).toBeNull();
  });

  it("opens the larger view over the work area, not modal, inside the Workspace, and asks for one row", async () => {
    const overlay = document.createElement("div");
    document.body.append(overlay);
    const setRows = vi.fn(),
      show = vi.fn();
    Object.defineProperty(HTMLDialogElement.prototype, "show", { configurable: true, value: show });
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    await act(async () =>
      root!.render(
        createElement(
          WorkspaceSlotContext.Provider,
          { value: { chat: null, overlay, setRows, setSummary: vi.fn() } },
          createElement(
            VisualDirectionsView,
            props({ cards: [card("A"), null, null], generation: { status: "partial", completed: 1 } }),
          ),
        ),
      ),
    );
    expect(setRows).toHaveBeenCalledWith(expect.any(Symbol), 1);
    await click(host.querySelector<HTMLButtonElement>("[aria-label='Enlarge Direction 1, Direction A']")!);
    expect(host.querySelector("dialog")).toBeNull();
    expect(overlay.querySelector(".e-workspace__overlay dialog")?.textContent).toContain("Verified board A");
    expect(show).toHaveBeenCalled();
    expect(showModal).not.toHaveBeenCalled();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
  });
});

describe("with the Workspace reply box", () => {
  it("leaves progress to the chat and Try again to the chat after a set that could not be drawn", async () => {
    await render(
      props({
        reply: "external",
        cards: [card("A"), null, null],
        generation: { status: "running", completed: 1, onGenerate: vi.fn(), onCheck: vi.fn(), onStop: vi.fn() },
      }),
    );
    expect(host.textContent).not.toContain("Creating your directions.");
    expect(button("Check progress")).toBeUndefined();
    expect(button("Stop generation")).toBeUndefined();
    expect(button("More directions")?.disabled).toBe(true);
    await render(props({ reply: "external", generation: { status: "failed", completed: 0, onGenerate: vi.fn() } }));
    expect(host.textContent).toContain("No directions yet");
    expect(button("More directions")).toBeUndefined();
  });
});

describe("a finished brand", () => {
  it("shows the chosen board large, marked as chosen, beside the chosen logo and its name", async () => {
    await act(async () =>
      root!.render(
        createElement(ChosenBrandView, {
          title: "Editorial Soft Shapes",
          board: createElement("p", null, "Verified board A"),
          enlarged: createElement("p", null, "Whole board A"),
          logo: { url: "blob:logo", failed: false, label: "Concept 1, version 2" },
        }),
      ),
    );
    expect(host.querySelector("h2")?.textContent).toBe("Your brand");
    const chosen = host.querySelector("article")!;
    expect(chosen.getAttribute("aria-label")).toBe("Chosen direction: Editorial Soft Shapes");
    expect(chosen.hasAttribute("data-selected")).toBe(true);
    expect(chosen.textContent).toContain("Chosen direction");
    // No Choose buttons: the brand is chosen; Change direction in the chat brings the boards back.
    expect(button("Choose")).toBeUndefined();
    expect(host.querySelector("figure img")?.getAttribute("alt")).toBe("Your logo");
    expect(host.querySelector("figcaption")?.textContent).toBe("Your logo · Concept 1, version 2");
    await click(host.querySelector<HTMLButtonElement>("[aria-label='Enlarge Editorial Soft Shapes']")!);
    expect(host.querySelector("dialog")?.textContent).toContain("Whole board A");
  });
});
