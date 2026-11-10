// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManualProjectName } from "@/components/naming/project-naming-workspace";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function type(value: string) {
  await act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
it("saves an honestly manual name and clears only after acknowledgement", async () => {
  const add = vi.fn<(source: unknown) => Promise<boolean>>().mockResolvedValue(true);
  await act(async () => root.render(<ManualProjectName disabled={false} onAdd={add} />));
  await type("My own name");
  await submit();
  expect(add).toHaveBeenCalledOnce();
  expect(add.mock.calls[0]![0]).toMatchObject({ value: "My own name", origin: "manual", history: [] });
  expect(host.querySelector("input")!.value).toBe("");
});
it("retains the spelling and reuses the exact identity after an uncertain save", async () => {
  const add = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await act(async () => root.render(<ManualProjectName disabled={false} onAdd={add} />));
  await type("Keep me");
  await submit();
  expect(host.querySelector("input")!.value).toBe("Keep me");
  expect(host.querySelector("input")!.disabled).toBe(true);
  await submit();
  expect(add.mock.calls[1]![0]).toEqual(add.mock.calls[0]![0]);
});
it("does not submit when account mutations are blocked", async () => {
  const add = vi.fn();
  await act(async () => root.render(<ManualProjectName disabled onAdd={add} />));
  await submit();
  expect(add).not.toHaveBeenCalled();
});
