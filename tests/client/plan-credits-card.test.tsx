// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingSummary } from "@/domain/billing";

const fixture = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 },
  }),
}));
vi.mock("@/components/workspace/account-api", () => ({ accountRequest: fixture.request }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => createElement("a", props, children),
}));
import { PlanCreditsCard } from "@/components/billing/plan-credits-card";

const billing: BillingSummary = {
  planId: "pro",
  balance: 112,
  periodEnd: "2026-12-01T00:00:00Z",
  subscription: null,
  plans: [
    { id: "free", name: "Free", monthlyCredits: 30 },
    { id: "pro", name: "Pro", monthlyCredits: 150 },
  ],
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.request.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Settings plan row", () => {
  it("shows the plan, credits left of the monthly credits and the renewal day, never money", async () => {
    fixture.request.mockResolvedValue({ billing });
    await act(async () => root.render(createElement(PlanCreditsCard)));
    expect([...host.querySelectorAll("dt")].map((node) => node.textContent)).toEqual([
      "Plan",
      "Credits left this month",
    ]);
    expect([...host.querySelectorAll("dd")].map((node) => node.textContent)).toEqual(["Pro", "112 of 150"]);
    expect(host.textContent).toContain("New credits arrive on December 1.");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/plans");
    expect(host.querySelector("a")?.textContent).toBe("See plans");
    expect(host.textContent).not.toMatch(/\$|USD|price/i);
  });

  it("holds the numbers' place while loading and offers Try again when the plan can't be read", async () => {
    let fail!: (error: unknown) => void;
    fixture.request.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    await act(async () => root.render(createElement(PlanCreditsCard)));
    expect(host.querySelectorAll(".e-skeleton")).toHaveLength(2);
    await act(async () => fail(new Error("offline")));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Your plan couldn’t be shown.");
    fixture.request.mockResolvedValue({ billing: { ...billing, planId: "free", balance: -3 } });
    await act(async () =>
      [...host.querySelectorAll("button")].find((node) => node.textContent === "Try again")!.click(),
    );
    expect([...host.querySelectorAll("dd")].map((node) => node.textContent)).toEqual(["Free", "0 of 30"]);
    expect(fixture.request).toHaveBeenCalledTimes(2);
  });
});
