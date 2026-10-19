// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { visibleNamingFeedCursor } from "@/components/naming/naming-feed-viewport";
import { cursor, entries, entry } from "./naming-progressive-fixture";

let root: HTMLDivElement, tail: HTMLDivElement;
beforeEach(() => {
  root = document.createElement("div"); root.dataset.namingResultsScroll = "true"; document.body.append(root);
  tail = document.createElement("div"); root.append(tail);
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 200 });
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 200));
});
afterEach(() => { root.remove(); vi.restoreAllMocks(); });
function card(position: number, top: number, left = 0) {
  const wrapper = document.createElement("div"); wrapper.className = "naming-feed-card";
  const article = document.createElement("article"); article.id = `project-name-${entry(position).entry.candidate.id}`;
  wrapper.append(article); root.insertBefore(wrapper, tail);
  vi.spyOn(article, "getBoundingClientRect").mockReturnValue(new DOMRect(left, top, 180, 80));
  return article;
}
it("reports the final actually visible saved card rather than the300 loaded tail", () => {
  card(199, -90); card(200, 20); card(201, 150); card(300, 900);
  expect(visibleNamingFeedCursor(tail, entries(1, 300))).toEqual(cursor(201));
});
it("ignores unrelated DOM identities and cards outside the horizontal viewport", () => {
  card(200, 20); card(201, 50, 601); card(999, 50);
  expect(visibleNamingFeedCursor(tail, entries(1, 300))).toEqual(cursor(200));
});
it.each(["disconnected", "hiddenRoot", "hiddenTail", "zeroSize", "offscreen", "noVisibleCard"] as const)("does not infer consumption from %s", mode => {
  card(200, mode === "noVisibleCard" ? 250 : 20);
  if (mode === "disconnected") root.remove();
  if (mode === "hiddenRoot") root.style.visibility = "hidden";
  if (mode === "hiddenTail") tail.style.visibility = "hidden";
  if (mode === "zeroSize") Object.defineProperty(root, "clientHeight", { configurable: true, value: 0 });
  if (mode === "offscreen") vi.mocked(root.getBoundingClientRect).mockReturnValue(new DOMRect(0, 9000, 600, 200));
  expect(visibleNamingFeedCursor(tail, entries(1, 300))).toBeNull();
});
