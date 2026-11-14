// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ status: "ready" as string }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    createElement("a", { href, ...rest }, children),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: { status: fixture.status, generation: 1 } }),
}));
import NotFound from "@/app/not-found";

afterEach(() => vi.unstubAllGlobals());

async function links(status: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.status = status;
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<NotFound />));
  const found = {
    heading: host.querySelector("h1")?.textContent,
    links: [...host.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")]),
    danger: Boolean(host.querySelector(".e-empty__visual--danger")),
  };
  await act(async () => root.unmount());
  return found;
}

it("offers Projects first when signed in, and Home always, in the page-error layout", async () => {
  expect(await links("ready")).toEqual({
    heading: "Page not found",
    links: [
      ["Go to Projects", "/brands"],
      ["Back to Home", "/"],
    ],
    danger: true,
  });
  expect((await links("signed_out")).links).toEqual([["Back to Home", "/"]]);
});
