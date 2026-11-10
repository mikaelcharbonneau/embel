// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ContextDetails } from "@/components/ui/context-details";
it("opens readable context without a disclosure triangle, retains drafts and restores focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
    close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ContextDetails title="Project details">
          <label>
            Project name
            <input defaultValue="Keep this draft" />
          </label>
        </ContextDetails>,
      ),
    );
    expect(host.querySelector("details,summary")).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!,
      input = host.querySelector("input")!,
      dialog = host.querySelector("dialog")!;
    await act(async () => trigger.click());
    expect(dialog.open).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    input.value = "My unsaved name";
    await act(async () => dialog.querySelector("button")!.click());
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    expect(host.querySelector("input")).toBe(input);
    expect(input.value).toBe("My unsaved name");
    await act(async () => {
      dialog.open = false;
      dialog.dispatchEvent(new Event("cancel"));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    if (show) Object.defineProperty(HTMLDialogElement.prototype, "showModal", show);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    if (close) Object.defineProperty(HTMLDialogElement.prototype, "close", close);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  }
});
