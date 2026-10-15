// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainSearchAdapter } from "@/features/domain-workspace/model";
import { ToolWorkspace } from "@/components/workspace/tool-workspace";

const fixture = vi.hoisted(() => ({
  status: "signed_out" as "checking" | "signed_out" | "unavailable" | "error" | "ready",
  live: null as null | { domains: DomainSearchAdapter },
  hasUnsaved: vi.fn(() => false),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: { status: fixture.status, generation: 1, userId: "fixture-owner" }, isCurrent: () => true, standaloneDrafts: { hasUnsaved: fixture.hasUnsaved } }),
  AccountStatus: () => <p>Account status: {fixture.status}</p>,
}));
vi.mock("@/components/tools/use-standalone-live-checks", () => ({ useStandaloneLiveChecks: () => fixture.live }));
vi.mock("@/components/tools/use-standalone-workspace", () => ({
  useStandaloneWorkspace: () => ({
    payload: { version: 1, input: "private-account.com", extensions: ["com"], candidates: ["private-account.com"] },
    status: "ready", canEdit: true, canSave: false, busy: false, dirty: false, pending: null, workspace: null, imports: [], error: null, setPayload: vi.fn(),
  }),
}));
vi.mock("@/components/tools/use-saved-standalone-promotion", () => ({ useSavedStandalonePromotion: () => ({ controls: null }) }));
vi.mock("@/components/tools/standalone-project-picker", () => ({ StandaloneProjectPicker: () => null }));

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  fixture.status = "signed_out"; fixture.live = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", vi.fn());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label)!;
async function render() { await act(async () => root.render(<ToolWorkspace tool="domains" />)); }
async function prepareManualSearch() {
  const input = host.querySelector<HTMLInputElement>('input[placeholder="Add a name or domain..."]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "example.com"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

describe("Domains account-aware lookup guidance", () => {
  it.each([
    ["checking", "Checking your account before enabling live domain availability and pricing."],
    ["signed_out", "Sign in to check live domain availability and prices, and save your shortlist."],
    ["unavailable", "Your account could not be verified. Recheck your account"],
    ["error", "Your account could not be verified. Recheck your account"],
  ] as const)("explains the %s state without claiming no registrar exists or enabling lookups", async (status, expected) => {
    fixture.status = status; await render(); await prepareManualSearch();
    expect(host.textContent).toContain(expected);
    expect(host.textContent).not.toContain("No registrar is connected");
    expect(host.textContent).not.toContain("private-account.com");
    expect(host.textContent).not.toContain("Confirmed available");
    expect(button("Check visible domains").disabled).toBe(true);
    expect(button("Check selected domains").title).toContain(expected);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps verified-owner lookups disabled while capability loading is unresolved", async () => {
    fixture.status = "ready"; await render();
    expect(host.textContent).toContain("Live domain checks and pricing are not ready");
    expect(host.textContent).not.toContain("No registrar is connected");
    expect(host.textContent).not.toContain("Sign in to check");
    expect(button("Check visible domains").disabled).toBe(true);
  });
  it("replaces pending guidance only with the verified capability result", async () => {
    fixture.status = "ready"; await render();
    fixture.live = { domains: { status: "unavailable", reason: "The configured lookup is temporarily unavailable." } };
    await render();
    expect(host.textContent).toContain("The configured lookup is temporarily unavailable.");
    expect(host.textContent).not.toContain("Live domain checks and pricing are not ready");
    expect(button("Check visible domains").disabled).toBe(true);
    const check = vi.fn();
    fixture.live = { domains: { status: "ready", provider: "synthetic-live-fixture", description: "Verified synthetic test capability.", check } };
    await render();
    expect(host.textContent).toContain("Verified synthetic test capability.");
    expect(button("Check visible domains").disabled).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
