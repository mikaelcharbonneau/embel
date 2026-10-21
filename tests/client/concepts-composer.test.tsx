// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConceptsComposer } from "@/components/logo-creation/concepts-composer";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } },
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); vi.unstubAllGlobals(); });
async function render(label?: string, instruction = "Kept local instruction", onReview = vi.fn()) {
  await act(async () => root.render(<ConceptsComposer projectId="fixture" selectedLabel={label} instruction={instruction} onInstructionChange={() => {}} onReview={onReview}><input aria-label="Saved brief" defaultValue="Kept brief" /></ConceptsComposer>));
  return onReview;
}
it("keeps refinement explicit, names its exact saved target and retains mounted edits when collapsed", async () => {
  const review = await render("Concept 2 · Version 3");
  const input = host.querySelector("textarea")!, form = host.querySelector("form")!;
  const toggle = host.querySelector<HTMLButtonElement>('[aria-controls]')!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(input.closest("[hidden]")).not.toBeNull();
  expect(host.textContent).toContain("Refinement target: Concept 2 · Version 3");
  await act(async () => toggle.click()); input.focus();
  expect(input.closest("[hidden]")).toBeNull();
  await render("Concept 2 · Version 3", "Kept instruction after read refresh", review);
  expect(host.querySelector("textarea")).toBe(input); expect(document.activeElement).toBe(input);
  await act(async () => toggle.click()); await act(async () => toggle.click());
  expect(host.querySelector("form")).toBe(form); expect(input.value).toBe("Kept instruction after read refresh");
  expect(review).not.toHaveBeenCalled();
});
it("keeps project context available with no selected logo and restores its trigger after cancel", async () => {
  await render();
  expect(host.querySelector<HTMLButtonElement>('[aria-controls]')!.disabled).toBe(true);
  const context = [...host.querySelectorAll("button")].find(button => button.textContent === "Project context")!;
  context.focus(); await act(async () => context.click());
  const dialog = host.querySelector("dialog")!, brief = dialog.querySelector("input")!;
  expect(dialog.open).toBe(true);
  await act(async () => dialog.dispatchEvent(new Event("cancel", { bubbles: false })));
  expect(dialog.open).toBe(false); expect(document.activeElement).toBe(context);
  await act(async () => context.click()); expect(dialog.querySelector("input")).toBe(brief);
});
