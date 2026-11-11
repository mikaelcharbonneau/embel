// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as Record<
    string,
    unknown
  >,
}));
vi.mock("next/link", () => ({
  default: ({ children, href, onClick, className }: ComponentProps<"a">) =>
    createElement("a", { href, className, onClick }, children),
}));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: fixture.session }) }));
import { PlansWorkspace, type PlansReturnState } from "@/components/billing/plans-workspace";

const plans = [
  { id: "free", name: "Free", monthlyCredits: 30 },
  { id: "pro", name: "Pro", monthlyCredits: 150 },
  { id: "studio", name: "Studio", monthlyCredits: 500 },
];
const freeSummary = { planId: "free", balance: 12, periodEnd: "2026-12-01T00:00:00Z", subscription: null, plans };
const proSummary = {
  planId: "pro",
  balance: 140,
  periodEnd: "2026-12-05T00:00:00Z",
  subscription: { planId: "pro", status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: "2026-12-05T00:00:00Z" },
  plans,
};

let root: Root, host: HTMLDivElement;
let requests: { path: string; init: RequestInit }[];
let summary: unknown;
const assign = vi.fn();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  requests = [];
  summary = freeSummary;
  fixture.session = { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 };
  assign.mockReset();
  vi.stubGlobal("location", { ...window.location, assign });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      if (path === "/api/billing") return Response.json({ billing: summary });
      return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_fake" });
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(returnState: PlansReturnState = null) {
  await act(async () => root.render(createElement(PlansWorkspace, { returnState })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
const buttons = () => [...host.querySelectorAll("button")].map((button) => button.textContent);

describe("Plans page", () => {
  it("shows the three plans with prices and monthly credits, and the current plan", async () => {
    await render();
    const text = host.textContent ?? "";
    for (const expected of ["Free", "$0", "Pro", "$7.99", "Studio", "$27.99", "150 credits every month", "500 credits"])
      expect(text).toContain(expected);
    expect(host.querySelector('[data-current="true"] h2')?.textContent).toBe("Free");
    expect(text).toContain("Credits left");
    expect(text).toContain("12");
    expect(buttons()).toEqual(["Upgrade to Pro", "Upgrade to Studio"]);
  });

  it("opens Checkout with one click, for the chosen plan and the signed-in account", async () => {
    await render();
    const upgrade = [...host.querySelectorAll("button")].find((button) => button.textContent === "Upgrade to Studio")!;
    await act(async () => upgrade.click());
    const checkout = requests.find((request) => request.path === "/api/billing/checkout")!;
    expect(JSON.parse(String(checkout.init.body))).toEqual({ plan: "studio" });
    expect((checkout.init.headers as Record<string, string>)["X-Embel-Account"]).toBe(fixture.session.userId);
    expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_fake");
  });

  it("offers Manage and Switch once subscribed", async () => {
    summary = proSummary;
    await render();
    expect(buttons()).toEqual(["Manage plan", "Cancel plan", "Switch to Studio"]);
    expect(host.textContent).toContain("To return to Free, use Cancel plan on your current plan.");
    const manage = [...host.querySelectorAll("button")].find((button) => button.textContent === "Manage plan")!;
    await act(async () => manage.click());
    const portal = requests.find((request) => request.path === "/api/billing/portal")!;
    expect(JSON.parse(String(portal.init.body))).toEqual({});
  });

  it("opens the cancellation of the current plan with one click", async () => {
    summary = proSummary;
    await render();
    const cancel = [...host.querySelectorAll("button")].find((button) => button.textContent === "Cancel plan")!;
    await act(async () => cancel.click());
    const portal = requests.find((request) => request.path === "/api/billing/portal")!;
    expect(JSON.parse(String(portal.init.body))).toEqual({ action: "cancel" });
    expect((portal.init.headers as Record<string, string>)["X-Embel-Account"]).toBe(fixture.session.userId);
  });

  it("explains a cancellation at the period end and the return states", async () => {
    summary = { ...proSummary, subscription: { ...proSummary.subscription, cancelAtPeriodEnd: true } };
    await render("checkout_success");
    expect(buttons()).not.toContain("Cancel plan");
    expect(host.textContent).toContain("Your plan ends on December");
    expect(host.textContent).toContain("Thank you. Your Pro plan is active.");
    await act(async () => root.unmount());
    root = createRoot(host);
    summary = freeSummary;
    await render("checkout_cancelled");
    expect(host.textContent).toContain("Checkout was cancelled. Nothing was charged.");
  });

  it("asks a signed-out visitor to sign in and never calls the billing API", async () => {
    fixture.session = { status: "signed_out", generation: 1 };
    await render();
    expect(host.textContent).toContain("Sign in to choose a plan.");
    expect(requests).toEqual([]);
  });
});
