// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE_VALUES } from "@/domain/account-profile";

const fixture = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 },
  profile: {} as Record<string, unknown>,
  edit: vi.fn(), save: vi.fn(), discard: vi.fn(), reload: vi.fn(), keepEdits: vi.fn(),
  usageMount: vi.fn(), usageUnmount: vi.fn(), ai: vi.fn(), localAI: vi.fn(), checkAccount: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: fixture.session }), AccountStatus: () => createElement("p", null, "Synthetic account status"),
}));
vi.mock("@/components/workspace/account-profile-provider", () => ({ useAccountProfile: () => fixture.profile }));
vi.mock("@/components/workspace/account-access", () => ({
  AccountAccess: () => createElement("button", { type: "button", onClick: fixture.checkAccount }, "Check account"),
}));
vi.mock("@/components/workspace/strategy-runtime-settings", () => ({
  StrategyRuntimeSettings: () => { fixture.ai(); return createElement("p", null, "Synthetic read-only text readiness"); },
}));
vi.mock("@/components/workspace/local-chatgpt-settings", () => ({
  LocalChatGPTSettings: ({ enabled }: { enabled: boolean }) => { fixture.localAI(enabled); return createElement("section", { "aria-label": "Synthetic local connection" }, "Local connection"); },
}));
vi.mock("@/components/workspace/recorded-usage", () => ({
  RecordedUsageSection: ({ active }: { active: boolean }) => {
    useEffect(() => { fixture.usageMount(); return () => { fixture.usageUnmount(); }; }, []);
    return createElement("section", { className: "recorded-usage", "aria-labelledby": "recorded-usage-title", "data-active": String(active) },
      createElement("h2", { id: "recorded-usage-title" }, "Recorded usage"), createElement("p", null, "Synthetic recent usage history"));
  },
}));
import { SettingsWorkspace } from "@/components/workspace/settings-workspace";

// Synthetic presentation/lifetime checks. Actual usage owner masking and request
// fencing remain exercised by the unchanged RecordedUsage continuity suites.
let root: Root, host: HTMLDivElement;
const tab = (id: string) => host.querySelector<HTMLButtonElement>(`#settings-tab-${id}`)!;
const panel = (id: string) => host.querySelector<HTMLElement>(`#settings-panel-${id}`)!;
const select = (id: string) => act(async () => tab(id).click());
async function render(localRuntimeEnabled = false) {
  await act(async () => root.render(createElement(SettingsWorkspace, { localRuntimeEnabled })));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  const saved = { ownerId: fixture.session.userId, email: "fixture@example.invalid", revision: 1, updatedAt: "2026-10-20T00:00:00Z", values: { ...DEFAULT_PROFILE_VALUES, fullName: "Synthetic account" } };
  fixture.profile = { workspace: { saved, values: saved.values, latest: null, mustReload: false }, busy: false, error: null, notice: null,
    edit: fixture.edit, save: fixture.save, discard: fixture.discard, reload: fixture.reload, keepEdits: fixture.keepEdits };
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Unexpected network request in presentation fixture"); }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  for (const action of [fixture.edit, fixture.save, fixture.discard, fixture.reload, fixture.keepEdits, fixture.checkAccount]) expect(action).not.toHaveBeenCalled();
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});

describe("Settings supported-first hierarchy", () => {
  it("prioritizes actual account fields and preserves them when unavailable details expand or loading changes", async () => {
    await render();
    const account = panel("account"), name = account.querySelector<HTMLInputElement>('input[autocomplete="name"]')!;
    const zone = account.querySelector<HTMLSelectElement>('select[aria-label="Time zone"]')!;
    const format = account.querySelector<HTMLSelectElement>('select[aria-label="Date format"]')!;
    expect(name.value).toBe("Synthetic account"); expect(name.disabled).toBe(false); expect(zone.disabled).toBe(false); expect(format.disabled).toBe(false);
    expect(account.querySelectorAll('select[aria-label="Language"], select[aria-label="Appearance"]')).toHaveLength(0);
    const unsupported = account.querySelector(".sg-availability")!, footer = account.querySelector(".sg-save")!;
    expect(footer.compareDocumentPosition(unsupported) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const details = unsupported.querySelector("details")!;
    expect(details.open).toBe(false); await act(async () => details.querySelector("summary")!.click()); expect(details.open).toBe(true);
    expect(unsupported.textContent).toContain("Profile photo"); expect(unsupported.textContent).toContain("English"); expect(unsupported.textContent).toContain("light appearance");
    expect(unsupported.querySelectorAll("button,input,select")).toHaveLength(0);
    expect(account.querySelector('input[autocomplete="name"]')).toBe(name); expect(account.querySelector('select[aria-label="Time zone"]')).toBe(zone);
    fixture.profile = { ...fixture.profile, busy: true }; await render();
    expect(account.querySelector('input[autocomplete="name"]')).toBe(name); expect(name.disabled).toBe(true);
    expect(account.querySelector('select[aria-label="Date format"]')).toBe(format); expect(format.disabled).toBe(true);
    expect(account.querySelector(".sg-save")).toBe(footer);
  });

  it.each([
    ["workspace", "Your workspace"], ["ai", "Text and strategy"], ["billing", "Recorded usage"],
    ["notifications", "Generation activity"], ["security", "Sign-in and security"], ["integrations", "Availability checks"],
  ])("puts useful information before unavailable %s controls", async (id, heading) => {
    await render(); await select(id);
    const current = panel(id);
    expect(current.querySelector("h2")!.textContent).toBe(heading);
    const unsupported = current.querySelector(".sg-availability")!;
    expect(unsupported.textContent).toContain("Not available yet"); expect(unsupported.textContent).not.toContain("Loading");
    expect(unsupported.querySelector("details")!.open).toBe(false);
    expect(unsupported.querySelectorAll("button,input,select")).toHaveLength(0);
    expect(current.querySelectorAll(".sg-save")).toHaveLength(0);
    expect([...current.querySelectorAll("button")].some(button => ["Save changes", "Cancel", "Connect"].includes(button.textContent ?? ""))).toBe(false);
  });

  it("retains all unavailable capability details as static information", async () => {
    await render();
    const expected = {
      workspace: ["Workspace name and handle", "Members and invitations", "Project sharing"],
      ai: ["Default model", "Creativity and response language", "Project context and remembered preferences", "Image quality"],
      billing: ["Current plan", "AI credits", "Payment method and billing email", "Invoices"],
      notifications: ["Generation completed", "Mentions and comments", "Workspace invitations", "Usage alerts", "Billing updates", "Product updates", "Tips and inspiration"],
      security: ["Password and two-factor authentication", "Active sessions", "Generation history and retention", "Help improve Embel", "Export account data", "Delete account"],
      integrations: ["Figma", "Google Drive", "Notion", "Slack", "Connection preferences"],
    };
    for (const [id, labels] of Object.entries(expected)) {
      await select(id);
      const details = panel(id).querySelector(".sg-availability details")!;
      await act(async () => details.querySelector("summary")!.click());
      expect([...details.querySelectorAll("dt")].map(node => node.textContent)).toEqual(labels);
    }
  });

  it("shows hosted or explicitly enabled local readiness ahead of unavailable preferences", async () => {
    await render(); expect(fixture.ai).not.toHaveBeenCalled(); expect(fixture.localAI).not.toHaveBeenCalled();
    await select("ai"); expect(fixture.ai).toHaveBeenCalled(); expect(fixture.localAI).not.toHaveBeenCalled();
    await render(true); expect(fixture.localAI).toHaveBeenCalledWith(true);
    expect(panel("ai").firstElementChild!.getAttribute("aria-label")).toBe("Synthetic local connection");
  });
});

describe("Usage hierarchy without changing its lifetime", () => {
  it("provides a direct header entry that mounts usage on demand and focuses its tab", async () => {
    await render(); expect(fixture.usageMount).not.toHaveBeenCalled();
    const entry = host.querySelector<HTMLButtonElement>(".sg-heading button")!;
    expect(entry.textContent).toBe("View recorded usage");
    await act(async () => entry.click());
    expect(tab("billing").getAttribute("aria-selected")).toBe("true"); expect(document.activeElement).toBe(tab("billing"));
    expect(fixture.usageMount).toHaveBeenCalledOnce(); expect(fixture.ai).not.toHaveBeenCalled();
    expect(panel("billing").firstElementChild).toBe(host.querySelector(".recorded-usage"));
  });

  it("retains the same usage section while billing details expand and categories change", async () => {
    await render(); await select("billing");
    const usage = host.querySelector(".recorded-usage")!;
    const details = panel("billing").querySelector<HTMLDetailsElement>(".sg-availability details")!;
    await act(async () => details.querySelector("summary")!.click());
    expect(host.querySelector(".recorded-usage")).toBe(usage); expect(fixture.usageMount).toHaveBeenCalledOnce();
    await select("workspace"); expect(host.querySelector(".recorded-usage")).toBe(usage);
    expect(panel("billing").hidden).toBe(true); expect(panel("billing").hasAttribute("inert")).toBe(true); expect(usage.getAttribute("data-active")).toBe("false");
    await select("billing"); expect(host.querySelector(".recorded-usage")).toBe(usage); expect(usage.getAttribute("data-active")).toBe("true");
    expect(details.open).toBe(true); expect(fixture.usageUnmount).not.toHaveBeenCalled(); expect(fixture.usageMount).toHaveBeenCalledOnce();
  });
});
