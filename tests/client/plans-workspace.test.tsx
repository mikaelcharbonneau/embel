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
    expect(host.querySelector('[data-selected="true"] h2')?.textContent).toBe("Free");
    expect(text).toContain("Credits left this month");
    expect(text).toContain("12");
    expect(text).toContain("New credits arrive on December 1.");
    for (const expected of ["About 1 complete brand a month", "About 7 complete brands a month", "Recommended"])
      expect(text).toContain(expected);
    expect(buttons()).toEqual(["Upgrade to Pro", "Upgrade to Studio"]);
    expect(host.querySelector(".e-button--primary")?.textContent).toBe("Upgrade to Pro");
  });

  it("lists what a credit buys, in credits only", async () => {
    await render();
    const rows = [...host.querySelectorAll("table tbody tr")].map((row) => row.textContent);
    expect(rows).toContain("Strategy · CompetitorsCompetitor research for your idea2");
    expect(rows).toContain("Identity · LogoSix logo concepts6");
    expect(host.textContent).toContain(
      "A complete brand with every step done once uses 19 credits, or 18 without a slogan.",
    );
    expect(host.querySelector("table")?.textContent).not.toContain("$");
  });

  it("states a zero balance in one sentence with the renewal date and the upgrade beside it", async () => {
    summary = { ...freeSummary, balance: 0 };
    await render();
    expect(host.textContent).toContain(
      "You’ve used this month’s 30 credits. New credits arrive on December 1. Your work is saved.",
    );
    expect(host.textContent).not.toContain("Credits left this month");
    const upgrade = host.querySelector<HTMLButtonElement>(".plans-out-of-credits button")!;
    expect(upgrade.textContent).toBe("Upgrade to Pro");
    await act(async () => upgrade.click());
    const checkout = requests.find((request) => request.path === "/api/billing/checkout")!;
    expect(JSON.parse(String(checkout.init.body))).toEqual({ plan: "pro" });
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
    expect(host.textContent).toContain("If you cancel Pro, you return to Free when the month you paid for ends.");
    expect(host.textContent).toContain("Your plan renews on December 5 with 150 new credits.");
    // Cancel is quieter than Manage plan (D-076).
    const classes = (label: string) =>
      [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.className;
    expect(classes("Manage plan")).toContain("e-button--secondary");
    expect(classes("Cancel plan")).toContain("e-button--quiet");
    expect(host.textContent).not.toContain("Recommended");
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
    expect(host.querySelector(".e-message")?.getAttribute("role")).toBe("status");
  });

  it("shows a payment failure in the same inline message as the success, with Try again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init: RequestInit) => {
        requests.push({ path, init });
        if (path === "/api/billing") return Response.json({ billing: summary });
        return new Response(null, { status: 503 });
      }),
    );
    await render();
    const upgrade = [...host.querySelectorAll("button")].find((button) => button.textContent === "Upgrade to Pro")!;
    await act(async () => upgrade.click());
    const alert = host.querySelector('.e-message--danger[role="alert"]')!;
    expect(alert.textContent).toContain(
      "Checkout couldn’t open because payments are unavailable right now. Nothing was charged.",
    );
    expect(assign).not.toHaveBeenCalled();
    const retry = [...alert.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => retry.click());
    expect(requests.filter((request) => request.path === "/api/billing/checkout")).toHaveLength(2);
  });

  it("asks a signed-out visitor to sign in and never calls the billing API", async () => {
    fixture.session = { status: "signed_out", generation: 1 };
    await render();
    expect(host.textContent).toContain("Already have an account? Sign in to see your plan and credits.");
    expect([...host.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Create free account", "/sign-up"],
      ["Create account to choose Pro", "/sign-up"],
      ["Create account to choose Studio", "/sign-up"],
      ["Sign in", "/sign-in"],
    ]);
    expect(requests).toEqual([]);
  });
});
