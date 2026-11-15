// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    createElement("a", { href, ...rest }, children),
}));
import NotFound from "@/app/not-found";

afterEach(() => vi.unstubAllGlobals());

it("names the missing page and offers one way back, in the page-error layout", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<NotFound />));
  expect(host.querySelector("h1")?.textContent).toBe("Page not found");
  expect([...host.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["Back to Home", "/"],
  ]);
  expect(host.querySelector(".e-empty__visual--danger")).not.toBeNull();
  expect(host.querySelector(".e-empty__text")).toBeNull();
  await act(async () => root.unmount());
});
