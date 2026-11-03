import { act } from "react";
import { expect } from "vitest";

// jsdom does not implement the native dialog methods or top-layer hit testing.
export function installNamePreviewDialog() {
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  HTMLDialogElement.prototype.close ??= function () { this.open = false; };
}
export function namePreview(host: HTMLElement) {
  return host.querySelector<HTMLDialogElement>("dialog[open]");
}
export async function openNamePreviewActions(host: HTMLElement) {
  const details = namePreview(host)?.querySelector("details");
  expect(details).toBeTruthy();
  const toggle = details!.querySelector("summary")!;
  expect(toggle.textContent).toContain("More actions");
  if (!details!.open) await act(async () => toggle.click());
  expect(details!.open).toBe(true);
}
