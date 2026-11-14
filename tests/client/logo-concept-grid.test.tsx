// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogoConceptGridView } from "@/components/logo-creation/concept-grid";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoConceptBatch } from "@/domain/logo-jobs";
import { WorkspaceSlotContext } from "@/components/workspace/workspace-slots";
import { syntheticLogoBatch } from "../fixtures/logo-creation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

/** Verified previews come back as blob URLs, which the reveal can read. */
const client = {
  previewAsset: vi.fn(async (receipt: { id: string }) => ({ url: `blob:preview-${receipt.id}`, release: vi.fn() })),
} as unknown as AccountLogoClient;

async function render(props: Partial<ComponentProps<typeof LogoConceptGridView>> & { batch: LogoConceptBatch }) {
  await act(async () =>
    root.render(
      createElement(LogoConceptGridView, { client, title: "Choose the concept you like most", subtitle: "", ...props }),
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const tile = (name: string) => host.querySelector<HTMLButtonElement>(`button.e-choice__hit[aria-label="${name}"]`);
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text)!;

describe("logo concepts as artwork only", () => {
  it("shows ready concepts as pictures that choose themselves, drawing and failed tiles without a button", async () => {
    const onSelectVersion = vi.fn();
    const batch = syntheticLogoBatch(["succeeded", "succeeded", "failed", "running", "succeeded", "failed"]);
    await render({ batch, onSelectVersion, drawingSlotIds: new Set([batch.slots[3]!.id]) });
    expect(host.querySelectorAll("ol > li")).toHaveLength(6);
    // No label row and no Choose button: the whole picture is the choice.
    expect(button("Choose")).toBeUndefined();
    expect(tile("Concept 1")?.getAttribute("aria-pressed")).toBe("false");
    expect(tile("Concept 3")).toBeNull();
    expect(host.textContent).toContain("Concept 3 couldn’t be drawn.");
    expect(host.textContent).toContain("Concept 6 couldn’t be drawn.");
    expect(host.querySelector('[role="img"][aria-label="Concept 4 is being drawn"]')).not.toBeNull();
    expect(host.querySelector(".e-media--inset img")?.getAttribute("src")).toMatch(/^blob:/u);
    await act(async () => tile("Concept 2")!.click());
    expect(onSelectVersion).toHaveBeenCalledWith({
      kind: "concept",
      batchId: batch.id,
      slotId: batch.slots[1]!.id,
      attemptId: batch.slots[1]!.attempts[0]!.id,
    });
  });

  it("enlarges any ready concept with previous, next and choosing from the larger view", async () => {
    const onSelectVersion = vi.fn();
    const batch = syntheticLogoBatch(["succeeded", "succeeded", "failed", "failed", "succeeded", "failed"]);
    await render({ batch, onSelectVersion });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Enlarge Concept 2"]')!.click());
    const dialog = () => host.querySelector("dialog");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Concept 2");
    expect(dialog()?.textContent).toContain("2 of 3 concepts");
    expect(dialog()?.querySelector(".e-media--16x9 img")).not.toBeNull();
    await act(async () => button("Next").click());
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Concept 5");
    await act(async () => button("Previous").click());
    await act(async () => button("Previous").click());
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Concept 1");
    await act(async () => button("Choose this concept").click());
    expect(onSelectVersion).toHaveBeenCalledTimes(1);
    expect(onSelectVersion.mock.calls[0]![0].slotId).toBe(batch.slots[0]!.id);
    expect(dialog()).toBeNull();
  });

  it("opens the larger view over the work area, not modal, inside the Workspace, and asks for two rows", async () => {
    const overlay = document.createElement("div");
    document.body.append(overlay);
    const setRows = vi.fn();
    const show = vi.fn(),
      showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    HTMLDialogElement.prototype.show = show;
    const slots = { chat: null, overlay, setRows, setSummary: vi.fn() };
    const batch = syntheticLogoBatch(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
    await act(async () =>
      root.render(
        createElement(
          WorkspaceSlotContext.Provider,
          { value: slots },
          createElement(LogoConceptGridView, {
            client,
            batch,
            title: "Choose the concept you like most",
            subtitle: "",
          }),
        ),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(setRows).toHaveBeenCalledWith(expect.any(Symbol), 2);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Enlarge Concept 2"]')!.click());
    expect(host.querySelector("dialog")).toBeNull();
    expect(overlay.querySelector(".e-workspace__overlay dialog h2")?.textContent).toBe("Concept 2");
    expect(show).toHaveBeenCalled();
    expect(showModal).not.toHaveBeenCalled();
    // Escape closes the larger view and returns to the work.
    await act(async () =>
      overlay
        .querySelector(".e-workspace__overlay")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(overlay.querySelector("dialog")).toBeNull();
  });

  it("keeps the pictures but turns their buttons off while a choice cannot be saved", async () => {
    await render({ batch: syntheticLogoBatch() });
    expect(tile("Concept 1")?.disabled).toBe(true);
  });

  it("reveals a concept that arrives while its tile is drawing, and not one that was already there", async () => {
    const running = syntheticLogoBatch(["succeeded", "running", "running", "running", "running", "running"]);
    await render({ batch: running, drawingSlotIds: new Set(running.slots.slice(1).map((slot) => slot.id)) });
    const frame = (ordinal: number) => host.querySelectorAll("ol > li")[ordinal]!.querySelector(".e-media")!;
    expect(frame(0).classList.contains("e-media--revealing")).toBe(false);
    expect(frame(1).classList.contains("e-media--drawing")).toBe(true);
    const arrived = syntheticLogoBatch(["succeeded", "succeeded", "running", "running", "running", "running"]);
    await render({ batch: arrived, drawingSlotIds: new Set(arrived.slots.slice(2).map((slot) => slot.id)) });
    expect(frame(1).classList.contains("e-media--revealing")).toBe(true);
    expect(frame(1).querySelector(".e-media__label")?.textContent).toBe("Concept 2");
    expect(frame(0).classList.contains("e-media--revealing")).toBe(false);
  });
});
