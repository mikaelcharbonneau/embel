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
describe("Domains account-aware lookup guidance", () => {
  it.each(["checking", "signed_out", "unavailable", "error"] as const)("requires a verified account in the %s state without opening a separate manual workspace", async status => {
    fixture.status = status; await render();
    expect(host.textContent).toContain(`Account status: ${status}`);
    expect(host.textContent).not.toContain("No registrar is connected");
    expect(host.textContent).not.toContain("private-account.com");
    expect(host.textContent).not.toContain("Confirmed available");
    expect(host.querySelector("input,textarea,form")).toBeNull();
    expect(button("Check visible domains")).toBeUndefined();
    expect(button("Check selected domains")).toBeUndefined();
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
