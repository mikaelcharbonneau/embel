// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConceptsComposer } from "@/components/logo-creation/concepts-composer";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
async function render(label?: string, instruction = "Kept local instruction", onGenerate = vi.fn(), footer?: ReactNode) {
  await act(async () => root.render(<ConceptsComposer projectId="fixture" selectedLabel={label} instruction={instruction} onInstructionChange={() => {}} onGenerate={onGenerate} footer={footer} />));
  return onGenerate;
}
it("keeps one visible refine box for the chosen logo and retains mounted edits across rerenders", async () => {
  const review = await render("Concept 2 · Version 3");
  const input = host.querySelector("textarea")!, form = host.querySelector("form")!;
  expect(host.querySelector("[aria-controls]")).toBeNull();
  expect(input.closest("[hidden]")).toBeNull();
  expect(input.getAttribute("aria-label")).toBe("Describe a change to this logo");
  expect(input.placeholder).toBe("Describe a change to this logo…");
  expect(form.textContent).toContain("Concept 2 · Version 3");
  expect(form.textContent).not.toContain("Refinement target");
  expect(form.textContent).not.toContain("Project context");
  input.focus();
  await render("Concept 2 · Version 3", "Kept instruction after read refresh", review);
  expect(host.querySelector("textarea")).toBe(input); expect(document.activeElement).toBe(input);
  expect(host.querySelector("form")).toBe(form); expect(input.value).toBe("Kept instruction after read refresh");
  expect(review).not.toHaveBeenCalled();
  const refine = [...form.querySelectorAll("button")].find(button => button.textContent === "Refine")!;
  await act(async () => refine.click()); expect(review).toHaveBeenCalledTimes(1);
});
it("has no separate brief panel, and shows the step's Continue alone below the refine box", async () => {
  await render();
  expect(host.querySelector("form")!.textContent).toContain("Choose a concept above to change it");
  expect(host.querySelector("dialog")).toBeNull(); expect(host.querySelector('[aria-haspopup="dialog"]')).toBeNull();
  expect([...host.querySelectorAll("button")].filter(button => !button.closest("form"))).toHaveLength(0);
  await render(undefined, "Kept local instruction", vi.fn(), <button type="button">Continue</button>);
  const next = [...host.querySelectorAll("button")].find(button => button.textContent === "Continue")!;
  expect(next.closest("form")).toBeNull(); expect(next.parentElement?.children).toHaveLength(1);
});
