// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("next/link", () => ({
  default: ({ children, href, onClick, className }: ComponentProps<"a">) =>
    createElement("a", { href, className, onClick }, children),
}));
import { OutOfCreditsPrompt } from "../../src/components/billing/out-of-credits-prompt";
import { accountRequest } from "../../src/components/workspace/account-api";

let host: HTMLDivElement;
let root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function refuse(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "insufficient_credits", message: "x" } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  await act(async () => {
    await accountRequest("/api/projects/p/generations", z.unknown(), {
      method: "POST",
      body: {},
      signal: new AbortController().signal,
    }).catch(() => undefined);
  });
}

describe("out-of-credits prompt", () => {
  it("offers the Plans page when a start is refused for lack of credits", async () => {
    act(() => root.render(createElement(OutOfCreditsPrompt, { pathname: "/brands/account/x/logo" })));
    expect(host.textContent).toBe("");
    await refuse(402);
    expect(host.textContent).toContain("You’re out of credits for this month");
    const link = host.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/plans");
    expect(link?.textContent).toBe("See plans");
    // Never a cost estimate.
    expect(host.textContent).not.toMatch(/\$|cost|price/i);
  });

  it("stays hidden for other refusals and can be dismissed", async () => {
    act(() => root.render(createElement(OutOfCreditsPrompt, { pathname: "/" })));
    await refuse(429);
    await refuse(409);
    expect(host.textContent).toBe("");
    await refuse(402);
    const dismiss = [...host.querySelectorAll("button")].find((button) => button.textContent === "Not now")!;
    act(() => dismiss.click());
    expect(host.textContent).toBe("");
  });

  it("is not shown on the Plans page itself", async () => {
    act(() => root.render(createElement(OutOfCreditsPrompt, { pathname: "/plans" })));
    await refuse(402);
    expect(host.textContent).toBe("");
  });
});
