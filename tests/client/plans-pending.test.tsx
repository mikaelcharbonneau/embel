// @vitest-environment jsdom
import { sessionStandIn } from "./session-stand-in";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Checkout refused while an earlier payment is still being confirmed (`billing_pending`, HTTP 409). The request
// layer is a stand-in that answers with that refusal; the billing summary and Stripe are never called.
const fixture = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 },
  summary: null as unknown,
  checkout: [] as unknown[],
  reads: 0,
}));
vi.mock("next/link", () => ({
  default: ({ children, href, className }: ComponentProps<"a">) => createElement("a", { href, className }, children),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => sessionStandIn({ session: fixture.session }),
}));
vi.mock("@/components/workspace/account-api", async (original) => {
  const actual = await original<typeof import("@/components/workspace/account-api")>();
  return {
    ...actual,
    accountRequest: async (path: string, _schema: unknown, init?: { body?: unknown }) => {
      if (path === "/api/billing") {
        fixture.reads += 1;
        return { billing: fixture.summary };
      }
      fixture.checkout.push(init?.body);
      // The code as the server sends it; the request layer's own list of codes is not this page's concern.
      throw new actual.AccountRequestError(409, "billing_pending" as never);
    },
  };
});
import { AccountRequestError } from "@/components/workspace/account-api";
import { billingErrorMessage, paymentPending, PlansWorkspace } from "@/components/billing/plans-workspace";

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
const sentence = "A plan payment is still being confirmed. Check again in a few minutes.";
let root: Root, host: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === label);
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  fixture.summary = freeSummary;
  fixture.checkout = [];
  fixture.reads = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("tells a payment still being confirmed from the other refusals", () => {
  expect(paymentPending(new AccountRequestError(409, "billing_pending" as never))).toBe(true);
  expect(paymentPending(new AccountRequestError(409))).toBe(false);
  expect(paymentPending(new AccountRequestError(409, "project_busy"))).toBe(false);
  expect(paymentPending(new Error("offline"))).toBe(false);
  // Another 409 on Checkout still means a paid plan exists.
  expect(billingErrorMessage(new AccountRequestError(409))).toBe(
    "You already have a paid plan. Use Manage plan to change or cancel it.",
  );
});

it("says the earlier payment is still being confirmed, with Check again, and reports no error", async () => {
  await act(async () => root.render(createElement(PlansWorkspace, {})));
  await settle();
  await act(async () => button("Upgrade to Pro")!.click());
  await settle();
  expect(fixture.checkout).toEqual([{ plan: "pro" }]);
  expect(host.textContent).toContain(sentence);
  // Not an error, and not something the person did: no alert, no "already have a paid plan", no Try again.
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector(".e-message--danger")).toBeNull();
  expect(host.textContent).not.toContain("You already have a paid plan");
  expect(host.textContent).not.toContain("couldn’t open");
  expect(button("Try again")).toBeUndefined();
  expect(button("Upgrade to Pro")!.getAttribute("aria-busy")).toBeNull();
  // Check again reads the plan; nothing is sent to Checkout again, and only the summary shows the new plan.
  await act(async () => button("Check again")!.click());
  await settle();
  expect(fixture.reads).toBe(2);
  expect(fixture.checkout).toHaveLength(1);
  expect(host.textContent).toContain(sentence);
  fixture.summary = proSummary;
  await act(async () => button("Check again")!.click());
  await settle();
  expect(host.textContent).not.toContain(sentence);
  expect(host.querySelector('[data-selected="true"] h2')?.textContent).toBe("Pro");
  expect(button("Check again")).toBeUndefined();
});
