// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installNamePreviewDialog } from "../fixtures/name-preview-dialog";
import { NameDetails } from "@/components/naming/name-details";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { contextSnapshotSchema } from "@/domain/projects";
import {
  nameIdentityKey,
  namingStrategyBasis,
  namingStrategyKey,
  type ProjectNameEntry,
} from "@/domain/project-naming";

const account: VerifiedAccount = { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 };
const isCurrent = (current: VerifiedAccount) =>
  current.userId === account.userId && current.generation === account.generation;
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ isCurrent }) }));
const caps = { ownerId: account.userId, domains: "rdap", youtube: true, euipo: true };
const now = Date.parse("2026-11-03T12:00:00Z"),
  at = new Date(now).toISOString();
const context = contextSnapshotSchema.parse({ description: "Synthetic name details" });
const ids = { ownerId: "a0000000-0000-4000-8000-000000000001", projectId: "b0000000-0000-4000-8000-000000000001" };
let candidateCount = 0;
function entry(value: string): ProjectNameEntry {
  const candidateId = `c0000000-0000-4000-8000-${String(++candidateCount).padStart(12, "0")}`;
  return {
    candidate: {
      ...ids,
      id: candidateId,
      value,
      identityKey: nameIdentityKey(value),
      rationale: `${value} says what the brand is in plain words.`,
      contextRevision: 1,
      strategyBasis: namingStrategyBasis(context),
      strategyKey: namingStrategyKey(context),
      createdAt: at,
      origin: {
        kind: "local_import",
        ...ids,
        candidateId,
        contextRevision: 1,
        source: { id: candidateId, value, createdAt: at, origin: "manual", history: [] },
        capturedContext: context,
      },
    },
    retention: { ...ids, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null },
  };
}

let root: Root | null, host: HTMLDivElement;
const callbacks = { onClose: vi.fn(), onChoose: vi.fn(), onSave: vi.fn(), onFavorite: vi.fn(), onRefresh: vi.fn() };
beforeEach(() => {
  installNamePreviewDialog();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  Object.values(callbacks).forEach((callback) => callback.mockReset());
});
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async (name = "River Coil", props: Partial<Parameters<typeof NameDetails>[0]> = {}) => {
  await act(() =>
    root!.render(
      <NameDetails
        account={account}
        entry={entry(name)}
        chosen={false}
        earlierContext={false}
        pending={false}
        blocked={false}
        steeringSelected={false}
        steeringDisabled={false}
        {...callbacks}
        {...props}
      />,
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
};
const buttons = () => [...document.querySelectorAll("button")];
const button = (name: string) =>
  buttons().find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
const click = async (name: string) => {
  expect(button(name), name).toBeDefined();
  await act(async () => button(name)!.click());
  await act(() => vi.advanceTimersByTimeAsync(0));
};
const posts = (lookup: ReturnType<typeof vi.fn>) =>
  lookup.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init.body)));
const rowOf = (domain: string) =>
  [...host.querySelectorAll("tbody tr")].find((row) => row.querySelector("td")?.textContent?.startsWith(domain));
const domainCheck = (domain: string, patch: Record<string, unknown> = {}) => ({
  id: `check-${domain}`,
  provider: "Public registry RDAP",
  domain,
  availability: "taken",
  checkedAt: at,
  validUntil: new Date(now + 60000).toISOString(),
  evidenceReference: "fixture",
  sourceUrl: `https://registry.example/${domain}`,
  ...patch,
});

it("lists the name's domains without checking any, then checks one domain only when its Check is pressed", async () => {
  const lookup = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json(caps);
    const { domain } = JSON.parse(String(init.body));
    return Response.json({
      ownerId: account.userId,
      result: { status: "domain", check: domainCheck(domain), quote: null },
    });
  });
  vi.stubGlobal("fetch", lookup);
  await render();
  expect(document.querySelector("dialog h2")?.textContent).toBe("River Coil");
  expect(document.querySelector("dialog")?.textContent).toContain("Your name");
  expect(lookup.mock.calls.map(([, init]) => init.method)).toEqual(["GET"]);
  expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("rivercoil");
  // The exact name in the popular extensions, plus the default tweaks.
  for (const domain of ["rivercoil.com", "rivercoil.net", "river-coil.com", "getriver.com", "riverhq.com"])
    expect(rowOf(domain), domain).toBeDefined();
  expect(rowOf("rivercoil.com")!.querySelector("[data-status]")?.textContent).toBe("Not checked");
  // Registry checks carry no prices, so there are no price columns.
  expect(host.querySelector("thead")?.textContent).not.toMatch(/First year|\$/);
  await click("Check rivercoil.com");
  expect(posts(lookup)).toEqual([{ tool: "domains", domain: "rivercoil.com" }]);
  const row = rowOf("rivercoil.com")!;
  expect(row.querySelector("[data-status]")?.textContent).toBe("Taken");
  expect(row.textContent).toContain("Checked with the public registry");
  expect(row.querySelector("a")?.getAttribute("href")).toBe("https://registry.example/rivercoil.com");
  expect(rowOf("rivercoil.net")!.querySelector("[data-status]")?.textContent).toBe("Not checked");
  await act(() => vi.advanceTimersByTimeAsync(60002));
  expect(rowOf("rivercoil.com")!.querySelector("[data-status]")?.textContent).toBe("Check expired");
  expect(posts(lookup)).toHaveLength(1);
});

it("shows registrar prices in USD only from a matching registrar quote, and premium only when the registrar says so", async () => {
  const quoteFor = (domain: string, cents: number) => ({
    id: `price-${domain}`,
    domain,
    provider: "vercel_registrar",
    checkId: `check-${domain}`,
    issuedAt: at,
    expiresAt: new Date(now + 60000).toISOString(),
    periodYears: 1,
    total: { amountMinor: cents, currency: "USD" },
    renewal: { amountMinor: 2898, currency: "USD" },
    renewalTerms: "Current renewal total for 1 year.",
  });
  const lookup = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json({ ...caps, domains: "vercel" });
    const { domain } = JSON.parse(String(init.body));
    const premium = domain === "amberfield.net";
    return Response.json({
      ownerId: account.userId,
      result: {
        status: "domain",
        check: domainCheck(domain, {
          provider: "vercel_registrar",
          availability: "available",
          detail: `Vercel reports this domain available.${premium ? " Premium domain." : ""} This does not reserve it.`,
        }),
        quote: quoteFor(domain, premium ? 245000 : 1298),
      },
    });
  });
  vi.stubGlobal("fetch", lookup);
  await render("Amber Field");
  expect(host.querySelector("thead")?.textContent).toContain("First year");
  expect(rowOf("amberfield.com")!.textContent).toContain("—");
  await click("Check amberfield.com");
  await click("Check amberfield.net");
  expect(rowOf("amberfield.com")!.querySelector("[data-status]")?.textContent).toBe("Available");
  expect(rowOf("amberfield.com")!.textContent).toContain("$12.98 / year");
  expect(rowOf("amberfield.com")!.textContent).toContain("$28.98");
  expect(rowOf("amberfield.net")!.querySelector("[data-status]")?.textContent).toBe("Premium");
  expect(rowOf("amberfield.net")!.textContent).toContain("$2,450.00 / year");
  await click("Hide premium");
  expect(rowOf("amberfield.net")).toBeUndefined();
  // Prices end with the registrar's quote window, with the check.
  await act(() => vi.advanceTimersByTimeAsync(60002));
  expect(rowOf("amberfield.com")!.textContent).not.toContain("$12.98");
});

it("offers official links without any lookup when no check is connected", async () => {
  const lookup = vi.fn(async () =>
    Response.json({ ownerId: account.userId, domains: "unavailable", youtube: false, euipo: false }),
  );
  vi.stubGlobal("fetch", lookup);
  await render("Cedar Loom");
  expect(button("Check cedarloom.com")).toBeUndefined();
  expect(rowOf("cedarloom.com")!.querySelector("a")?.href).toContain("lookup.icann.org");
  expect(rowOf("cedarloom.com")!.querySelector("[data-status]")?.textContent).toBe("Not checked");
  await click("Handles");
  expect(buttons().some((b) => b.textContent?.startsWith("Check "))).toBe(false);
  const links = [...host.querySelectorAll<HTMLAnchorElement>("tbody a")].map((a) => a.href);
  expect(links).toContain("https://www.youtube.com/@cedarloom");
  expect(links).toContain("https://www.instagram.com/cedarloom/");
  await click("Trademarks");
  expect(button("Search the EU register")).toBeUndefined();
  expect([...host.querySelectorAll<HTMLAnchorElement>("a")].map((a) => a.href)).toContain(
    "https://euipo.europa.eu/eSearch/",
  );
  expect(host.textContent).not.toMatch(/No exact match|Available/);
  expect(lookup).toHaveBeenCalledOnce();
});

it("checks YouTube for the listed handles on one press and links the other platforms", async () => {
  const lookup = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json(caps);
    const { handle } = JSON.parse(String(init.body));
    return Response.json({
      ownerId: account.userId,
      result: {
        status: "handle",
        evidence: {
          platform: "youtube",
          handle,
          outcome: handle === "rivercoil" ? "taken" : "confirmed_available",
          authority: "platform_api",
          source: "YouTube Data API",
          sourceUrl: "https://developers.google.com/youtube/v3",
          method: "channels.list forHandle",
          checkedAt: at,
          observedAt: at,
          detail: "Fixture",
        },
      },
    });
  });
  vi.stubGlobal("fetch", lookup);
  await render();
  await click("Handles");
  const handle = host.querySelector<HTMLInputElement>("input")!;
  expect(handle.value).toBe("rivercoil");
  await click("None");
  await act(() => {
    const suffixes = [...host.querySelectorAll<HTMLInputElement>("input")][2]!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(suffixes, "hq");
    suffixes.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(posts(lookup)).toHaveLength(0);
  await click("Check 2 handles on YouTube");
  expect(posts(lookup)).toEqual([
    { tool: "handles", platform: "youtube", handle: "rivercoil" },
    { tool: "handles", platform: "youtube", handle: "rivercoilhq" },
  ]);
  const statuses = [...host.querySelectorAll("tbody [data-status]")].map((badge) => badge.textContent);
  expect(statuses).toEqual(["Taken", "Available"]);
  expect(host.textContent).toContain("For the other platforms, Open shows whether the profile exists.");
});

it("searches the EU register on demand and never presents it as legal clearance", async () => {
  const lookup = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json(caps);
    const query = JSON.parse(String(init.body));
    return Response.json({
      ownerId: account.userId,
      result: {
        status: "trademark",
        research: {
          query,
          searched: ["EM"],
          missing: [],
          hits: [],
          checkedAt: at,
          datasetAsOf: null,
          completeness: "partial",
          interrupted: null,
          sourceUrl: "https://euipo.europa.eu/eSearch/",
          legalClearance: "not_assessed",
          filing: "not_submitted",
        },
      },
    });
  });
  vi.stubGlobal("fetch", lookup);
  await render();
  await click("Trademarks");
  expect(posts(lookup)).toHaveLength(0);
  await click("Search the EU register");
  expect(posts(lookup)).toEqual([
    { tool: "trademarks", mark: "River Coil", jurisdictions: ["EM"], niceClasses: [], mode: "exact_word" },
  ]);
  expect(host.textContent).toContain("No exact match in the EU register");
  expect(host.textContent).toContain("not legal clearance");
});

it("aborts a pending domain check when the details close and ignores its late answer", async () => {
  const pending: { signal: AbortSignal; finish: () => void }[] = [];
  const lookup = vi.fn(async (_path: string, init: RequestInit) =>
    init.method === "GET"
      ? Response.json(caps)
      : new Promise<Response>((resolve) =>
          pending.push({
            signal: init.signal!,
            finish: () =>
              resolve(
                Response.json({
                  ownerId: account.userId,
                  result: { status: "failed", code: "timeout", retryAfterSeconds: null },
                }),
              ),
          }),
        ),
  );
  vi.stubGlobal("fetch", lookup);
  await render("Delta Fern");
  await click("Check deltafern.com");
  expect(rowOf("deltafern.com")!.textContent).toContain("Checking…");
  await act(() => root!.unmount());
  root = null;
  expect(pending[0]!.signal.aborted).toBe(true);
  await act(() => pending[0]!.finish());
});

it("chooses, saves and favorites the name from its details, and closes on Close", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(caps)),
  );
  await render("Kestrel Analytics");
  await click("Choose this name");
  expect(callbacks.onChoose).toHaveBeenCalledOnce();
  await click("Save name");
  expect(callbacks.onSave).toHaveBeenCalledOnce();
  await click("Favorite Kestrel Analytics");
  expect(callbacks.onFavorite).toHaveBeenCalledOnce();
  await click("Close name details");
  expect(callbacks.onClose).toHaveBeenCalledOnce();
  await render("Kestrel Analytics", { chosen: true });
  expect(button("Chosen name")?.disabled).toBe(true);
  expect(button("Choose this name")).toBeUndefined();
});

it("opens in the Workspace overlay without a modal, and Escape closes only the topmost dialog", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(caps)),
  );
  const overlay = document.createElement("div");
  document.body.append(overlay);
  const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
  try {
    await render("River Coil", { overlay });
    expect(overlay.querySelector(".e-workspace__overlay dialog[open]")).not.toBeNull();
    expect(showModal).not.toHaveBeenCalled();
    await click("Extensions · 7");
    expect(overlay.querySelectorAll(".e-workspace__overlay")).toHaveLength(2);
    await act(async () => {
      overlay
        .querySelectorAll(".e-workspace__overlay")[1]!
        .querySelector("dialog")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(overlay.querySelectorAll(".e-workspace__overlay")).toHaveLength(1);
    expect(callbacks.onClose).not.toHaveBeenCalled();
    await act(async () => {
      overlay.querySelector("dialog")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  } finally {
    showModal.mockRestore();
    overlay.remove();
  }
});

it("applies extensions and tweaks from their second dialogs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(caps)),
  );
  await render();
  await click("Extensions · 7");
  await click("Clear all");
  await click(".studio");
  await click("Search 1 extension");
  expect(rowOf("rivercoil.studio")).toBeDefined();
  expect(rowOf("rivercoil.com")).toBeUndefined();
  await click("Tweaks · 3");
  await click("Turn all off");
  await click("Search without tweaks");
  expect([...host.querySelectorAll("tbody tr")].map((row) => row.querySelector("td")?.textContent)).toEqual([
    "rivercoil.studio",
  ]);
});
