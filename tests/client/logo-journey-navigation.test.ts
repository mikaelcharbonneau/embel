// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LogoJourneyNavigation, type LogoJourneyStage } from "@/components/identity/logo-journey-navigation";

const projectId = "d0000000-0000-4000-8000-000000000001";
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; document.body.innerHTML = ""; vi.unstubAllGlobals();
});
async function render(current: LogoJourneyStage, id = projectId) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(LogoJourneyNavigation, { projectId: id, current })));
  return host;
}
it("links the saved project directly to vector review, not the raster editor alias", async () => {
  const host = await render("directions");
  expect([...host.querySelectorAll("a")].map(a => a.getAttribute("href"))).toEqual([
    `/brands/account/${projectId}/inspiration`,
    `/brands/account/${projectId}/logo`,
    `/brands/account/${projectId}/brand-board`,
    `/brands/account/${projectId}/logo/vector`,
    `/brands/account/${projectId}/logo/directions`,
    `/brands/account/${projectId}/identity`,
  ]);
  expect(host.querySelector('a[href$="/editor"]')).toBeNull();
  expect(host.querySelectorAll("button")).toHaveLength(0);
});
it.each([
  ["inspiration", "Inspiration"], ["concepts", "Logo concepts"], ["board", "Brand board"], ["vector", "Vector review"], ["directions", "Identity directions"], ["systems", "Moodboard & systems"],
] as const)("marks only %s as the current stage", async (current, label) => {
  const host = await render(current);
  expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe(label);
});
it("does not construct navigation from a malformed project id", async () => {
  const host = await render("directions", "../../foreign");
  expect(host.querySelectorAll("a")).toHaveLength(0);
});
