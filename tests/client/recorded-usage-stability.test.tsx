// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordedUsageSection } from "@/components/workspace/recorded-usage";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { RECORDED_USAGE_LIMIT, type RecordedUsage } from "@/domain/recorded-usage";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mock = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as
    VerifiedAccount | { status: "checking" | "signed_out" | "unavailable" | "error"; generation: number },
  current: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire }),
}));
vi.mock("@/components/workspace/browser-local-date", () => ({
  BrowserLocalDate: ({ dateTime }: { dateTime: string }) => createElement("time", { dateTime }, dateTime),
}));
type Request = { resolve(response: Response): void; reject(error: unknown): void; signal: AbortSignal };
let root: Root, host: HTMLDivElement, requests: Request[], fetcher: ReturnType<typeof vi.fn>;
function snapshot(count = 20, ownerId = owner): RecordedUsage {
  return {
    ownerId,
    limit: 20,
    entries: Array.from({ length: count }, (_, index) => ({
      id: `cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, "0")}`,
      operation: "naming.generate",
      completedAt: "2026-10-19T12:00:00Z",
      tokens: { inputTokens: index, outputTokens: 2, totalTokens: index + 2 },
    })),
  };
}
const render = () => act(async () => root.render(createElement(RecordedUsageSection)));
const settle = (index: number, body = snapshot(), status = 200) =>
  act(async () => requests[index]!.resolve(Response.json(body, { status })));
const refresh = () => host.querySelector<HTMLButtonElement>(".recorded-usage-refresh")!;
const rows = () => [...host.querySelectorAll(".recorded-usage-entry")];
const live = () => host.querySelector<HTMLElement>('[role="status"]')!;
const summary = () => host.querySelector(".recorded-usage-summary")?.textContent;
const coverage = "Logo and image requests are not included.";
function expectSameRows(original: Element[]) {
  const current = rows();
  expect(current).toHaveLength(original.length);
  current.forEach((row, index) => expect(row).toBe(original[index]));
}
async function loaded() {
  await render();
  await settle(0);
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.current
    .mockReset()
    .mockImplementation(
      (account: VerifiedAccount) =>
        mock.session.status === "ready" &&
        mock.session.userId === account.userId &&
        mock.session.generation === account.generation,
    );
  mock.expire.mockReset().mockImplementation(() => {
    mock.session = { status: "signed_out", generation: 2 };
    root.render(createElement(RecordedUsageSection));
  });
  requests = [];
  fetcher = vi.fn(
    (_path: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) =>
        requests.push({ resolve, reject, signal: init.signal as AbortSignal }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Recorded usage presentation", () => {
  it("shows a plain step, date and tokens-used table with a summary and no visible loading text", async () => {
    await loaded();
    expect(host.querySelector("h2")?.textContent).toBe("Recent requests");
    expect([...host.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
      "Step",
      "Date",
      "Tokens used",
    ]);
    expect(rows()).toHaveLength(20);
    expect([...rows()[3]!.children].map((cell) => cell.textContent)).toEqual([
      "Voice · Name",
      "2026-10-19T12:00:00Z",
      "5",
    ]);
    // 20 requests of (index + 2) tokens each.
    expect(summary()).toBe("Last 20 requests · 230 tokens used");
    expect(live().className).toBe("sr-only");
    expect(live().textContent).toBe("Usage loaded.");
    expect(host.querySelector(".recorded-usage-note")?.textContent).toBe(coverage);
    expect(host.textContent).not.toMatch(
      /Input tokens|Output tokens|Total tokens|Unknown|Billing|\$|USD|OpenAI|ChatGPT/,
    );
    expect(refresh().textContent).toBe("Refresh");
  });

  it("adds input and output when no total was sent, and marks unrecorded requests once", async () => {
    await render();
    const data = snapshot(3);
    data.entries[0]!.operation = "strategy.personality";
    data.entries[0]!.tokens = { inputTokens: 1200, outputTokens: 345, totalTokens: null };
    data.entries[1]!.tokens = null;
    data.entries[2]!.tokens = null;
    await settle(0, data);
    expect(rows()[0]!.querySelector("th")?.textContent).toBe("Voice · Personality");
    expect(rows()[0]!.lastElementChild?.textContent).toBe("1,545");
    for (const row of rows().slice(1)) {
      expect(row.lastElementChild?.querySelector('[aria-hidden="true"]')?.textContent).toBe("—");
      expect(row.lastElementChild?.querySelector(".sr-only")?.textContent).toBe("Not recorded for this request.");
    }
    expect([...host.querySelectorAll(".recorded-usage-note")].map((note) => note.textContent)).toEqual([
      "— Not recorded for this request.",
      coverage,
    ]);
    expect(summary()).toBe("3 requests · at least 1,545 tokens used");
  });

  it.each([
    [1, true, "1 request · 2 tokens used"],
    [2, false, "2 requests · tokens not recorded"],
    [0, true, "No requests yet. Your usage appears here after Embel completes a step for you."],
  ] as const)("summarizes %i recorded requests plainly (recorded=%s)", async (count, recorded, expected) => {
    await render();
    const data = snapshot(count);
    if (!recorded)
      data.entries.forEach((entry) => {
        entry.tokens = null;
      });
    await settle(0, data);
    expect(summary()).toBe(expected);
    expect(host.querySelector("table")).toBe(count ? host.querySelector(".recorded-usage-table") : null);
  });

  it("shows complete long labels, dates and token values without padding a sparse result to the public capacity", async () => {
    await render();
    const data = snapshot(1);
    data.entries[0]!.operation = "strategy.competitors";
    data.entries[0]!.completedAt = "2026-10-19T12:00:00+05:30";
    data.entries[0]!.tokens = {
      inputTokens: Number.MAX_SAFE_INTEGER - 1,
      outputTokens: 1,
      totalTokens: Number.MAX_SAFE_INTEGER,
    };
    await settle(0, data);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.querySelector("th")?.textContent).toBe("Strategy · Competitors");
    expect(rows()[0]!.querySelector("time")?.textContent).toBe(data.entries[0]!.completedAt);
    expect(rows()[0]!.lastElementChild?.textContent).toBe("9,007,199,254,740,991");
    expect(summary()).toBe("1 request · 9,007,199,254,740,991 tokens used");
    expect(host.querySelector(".recorded-usage-pending-frame, .recorded-usage-pending-slot")).toBeNull();
  });

  it("defines shared row and loading-slot sizes without clipping text in scoped CSS", () => {
    // Source contract only: jsdom does not establish browser pixel equality.
    const css = readFileSync("src/styles/recorded-usage.css", "utf8");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
    const declarations = (selector: string) =>
      rules
        .filter((match) => match[1]!.split(",").some((item) => item.trim() === selector))
        .map((match) => match[2])
        .join(" ");
    expect(declarations(".recorded-usage-entry > *")).toMatch(/block-size:\s*45px;/);
    expect(declarations(".recorded-usage-pending-slot")).toMatch(/min-block-size:\s*45px;/);
    expect(declarations(".recorded-usage-entry > *")).toMatch(/border-bottom:\s*1px solid var\(--border\);/);
    expect(declarations(".recorded-usage-pending-slot")).toMatch(/border-bottom:\s*1px solid var\(--border\);/);
    expect(declarations(".recorded-usage")).toMatch(/border-radius:\s*var\(--radius-card\);/);
    expect(declarations(".recorded-usage-table th")).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(css).not.toMatch(
      /max-height|max-block-size|overflow:\s*(?:hidden|clip)|text-overflow:\s*ellipsis|line-clamp:/,
    );
  });
});

describe("Recorded usage refresh continuity", () => {
  it.each([0, 1, 20])(
    "uses the same anonymous public-limit frame after %i private rows and through the following initial read",
    async (priorCount) => {
      await render();
      await settle(0, snapshot(priorCount));
      await act(async () => refresh().click());
      mock.session = { status: "checking", generation: 2 };
      await render();
      const frame = host.querySelector(".recorded-usage-pending-frame")!;
      expect(frame).not.toBeNull();
      expect(frame.getAttribute("aria-hidden")).toBe("true");
      expect(frame.hasAttribute("inert")).toBe(true);
      expect(frame.children).toHaveLength(RECORDED_USAGE_LIMIT);
      expect(frame.textContent).toBe("");
      expect(frame.getAttribute("style")).toBeNull();
      expect(
        [...frame.children].every(
          (slot) => slot.className === "recorded-usage-pending-slot" && slot.attributes.length === 1,
        ),
      ).toBe(true);
      expect(
        host.querySelector(".recorded-usage")!.querySelector("table, time, button, a, input, [tabindex], [style]"),
      ).toBeNull();
      expect(host.querySelector(".recorded-usage-note")?.textContent).toBe(coverage);
      expect(rows()).toHaveLength(0);
      expect(refresh()).toBeNull();
      expect(live().textContent).toBe("Checking your account…");
      expect(live().className).toBe("sr-only");
      expect(summary()).toBe("Requests Embel completed for you, newest first.");
      expect(host.textContent).not.toContain("2026-10-19");
      await settle(1);
      expect(rows()).toHaveLength(0);
      mock.session = { status: "ready", userId: owner, generation: 2 };
      await render();
      expect(host.querySelector(".recorded-usage-pending-frame")?.children).toHaveLength(RECORDED_USAGE_LIMIT);
      expect(live().textContent).toBe("Loading usage…");
      expect(refresh().getAttribute("aria-disabled")).toBe("true");
      await settle(2, snapshot(0));
      expect(host.querySelector(".recorded-usage-pending-frame")).toBeNull();
      expect(summary()).toContain("No requests yet");
    },
  );

  it.each(["signed_out", "unavailable", "error"] as const)(
    "does not disguise %s as an indefinite usage loader",
    async (status) => {
      await loaded();
      mock.session = { status, generation: 2 };
      await render();
      expect(rows()).toHaveLength(0);
      expect(refresh()).toBeNull();
      expect(host.querySelector(".recorded-usage-pending-frame")).toBeNull();
      expect(host.querySelector(".recorded-usage-message")?.textContent).toBe(
        status === "signed_out"
          ? "Sign in to see your usage."
          : "Your usage can’t be shown right now. Check your connection and try again.",
      );
    },
  );

  it("removes the anonymous initial-read frame on failure without inventing an empty account", async () => {
    await render();
    expect(host.querySelector(".recorded-usage-pending-frame")).not.toBeNull();
    await settle(0, snapshot(), 503);
    expect(host.querySelector(".recorded-usage-pending-frame")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Usage couldn’t be loaded. Check your connection and try again.",
    );
    expect(host.textContent).not.toContain("No requests yet");
  });

  it("retains all rows, the refresh trigger and focus through a deduplicated refresh", async () => {
    await loaded();
    const original = rows(),
      button = refresh();
    button.focus();
    await act(async () => {
      button.click();
      button.click();
    });
    await act(async () => button.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expectSameRows(original);
    expect(rows()).toHaveLength(20);
    expect(refresh()).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(live().textContent).toBe("Refreshing usage…");
    await settle(1);
    expectSameRows(original);
    expect(refresh()).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("keeps the same announcer, header and button through refresh while a failure stays visible", async () => {
    await loaded();
    const status = live(),
      header = host.querySelector(".recorded-usage-header")!;
    const button = refresh();
    button.focus();
    expect(status.textContent).toBe("Usage loaded.");
    await act(async () => button.click());
    expect(live()).toBe(status);
    expect(status.textContent).toBe("Refreshing usage…");
    expect(host.querySelector(".recorded-usage-header")).toBe(header);
    expect(refresh()).toBe(button);
    expect(document.activeElement).toBe(button);
    await settle(1, snapshot(), 503);
    expect(live()).toBe(status);
    expect(status.textContent).toBe("");
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.className).toBe("recorded-usage-error");
    expect(alert.textContent).toBe(
      "Usage couldn’t be refreshed. The list shows the last results. Check your connection and try again.",
    );
    expect(host.querySelector(".recorded-usage-header")).toBe(header);
    expect(refresh()).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("keeps prior rows and the same retry trigger after failure, then updates recorded tokens", async () => {
    await loaded();
    const original = rows(),
      button = refresh();
    button.focus();
    await act(async () => button.click());
    await settle(1, snapshot(), 503);
    expectSameRows(original);
    expect(refresh()).toBe(button);
    expect(host.textContent).toContain("The list shows the last results");
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    const updated = snapshot();
    updated.entries[0]!.tokens = { inputTokens: 5, outputTokens: 6, totalTokens: 11 };
    await settle(2, updated);
    expectSameRows(original);
    expect(original[0]!.lastElementChild?.textContent).toBe("11");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps an initial read failure retryable without inventing history", async () => {
    await render();
    await settle(0, snapshot(), 503);
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("Usage couldn’t be loaded");
    await act(async () => refresh().click());
    await settle(1, snapshot(0));
    expect(rows()).toHaveLength(0);
    expect(summary()).toContain("No requests yet");
    expect(host.textContent).not.toContain("couldn’t be loaded");
  });

  it("retains the recorded history on a timed-out refresh and permits an explicit retry", async () => {
    vi.useFakeTimers();
    await loaded();
    const original = rows(),
      button = refresh();
    await act(async () => button.click());
    requests[1]!.signal.addEventListener(
      "abort",
      () => requests[1]!.reject(new DOMException("Aborted", "AbortError")),
      { once: true },
    );
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(requests[1]!.signal.aborted).toBe(true);
    expectSameRows(original);
    expect(refresh()).toBe(button);
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => button.click());
    await settle(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([owner, other])(
    "removes old history at a new generation and fences its late refresh (%s)",
    async (nextOwner) => {
      await loaded();
      await act(async () => refresh().click());
      mock.session = { status: "ready", userId: nextOwner, generation: 2 };
      await render();
      expect(rows()).toHaveLength(0);
      expect(requests[1]!.signal.aborted).toBe(true);
      await settle(1);
      expect(rows()).toHaveLength(0);
      await settle(2, snapshot(1, nextOwner));
      expect(rows()).toHaveLength(1);
    },
  );

  it("immediately hides private history during account checking and ignores a late reply", async () => {
    await loaded();
    await act(async () => refresh().click());
    mock.session = { status: "checking", generation: 2 };
    await render();
    expect(rows()).toHaveLength(0);
    expect(refresh()).toBeNull();
    await settle(1);
    expect(rows()).toHaveLength(0);
    expect(live().textContent).toBe("Checking your account…");
  });

  it.each(["unauthorized", "wrong-owner"])("expires rather than retaining readable history on %s", async (failure) => {
    await loaded();
    await act(async () => refresh().click());
    await settle(1, snapshot(1, failure === "wrong-owner" ? other : owner), failure === "unauthorized" ? 401 : 200);
    expect(mock.expire).toHaveBeenCalledOnce();
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("Sign in to see your usage.");
  });
});
