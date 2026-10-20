// @vitest-environment jsdom
import { act } from "react";
import Link from "next/link";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetsWorkspace } from "@/components/assets/assets-workspace";
import { SettingsWorkspace } from "@/components/workspace/settings-workspace";
import type { useAssetLibrary } from "@/components/assets/use-asset-library";

const fixture = vi.hoisted(() => ({
  session: { status: "ready", userId: "fixture-owner", generation: 1 },
  library: null as unknown as ReturnType<typeof useAssetLibrary>,
  useLibrary: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: fixture.session }),
  AccountStatus: () => <Link href="/sign-in">Sign in to view your account projects.</Link>,
}));
vi.mock("@/components/assets/use-asset-library", () => ({ useAssetLibrary: () => { fixture.useLibrary(); return fixture.library; } }));
vi.mock("@/components/assets/asset-detail", () => ({ AssetDetailDialog: () => null }));
vi.mock("@/components/assets/asset-preview", () => ({ AssetPreview: () => null }));
vi.mock("@/components/workspace/account-profile-editor", () => ({ AccountProfileEditor: () => null }));
vi.mock("@/components/workspace/account-access", () => ({ AccountAccess: () => null }));
vi.mock("@/components/workspace/local-chatgpt-settings", () => ({ LocalChatGPTSettings: () => null }));
vi.mock("@/components/workspace/strategy-runtime-settings", () => ({ StrategyRuntimeSettings: () => null }));
vi.mock("@/components/workspace/recorded-usage", () => ({ RecordedUsageSection: () => null }));

let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  fixture.session = { status: "ready", userId: "fixture-owner", generation: 1 };
  fixture.useLibrary.mockClear();
  fixture.library = { query: { tab: "my_selection" }, page: { items: [], nextCursor: null }, projects: [], status: "ready", busy: false, error: null, refresh: vi.fn(), changeQuery: vi.fn() } as unknown as ReturnType<typeof useAssetLibrary>;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

// Capability-neutral guidance must not probe a provider or infer readiness from
// an unrelated library load or app-connection state.
describe("Assets generation guidance", () => {
  it.each(["ready", "loading", "error"] as const)("describes saved files without a global generation claim when library is %s", async status => {
    fixture.library = { ...fixture.library, status, error: status === "error" ? "Assets could not be loaded." : null };
    await act(async () => root.render(<AssetsWorkspace />));
    const note = host.querySelector(".assets-generation-note")!;
    expect(note.textContent).toContain("files and versions already saved in your account");
    expect(note.textContent).toContain("logo concepts and saved-preview refinements");
    expect(note.textContent).toContain("Available operations are shown in its logo workspace");
    expect(note.querySelector("a")?.getAttribute("href")).toBe("/brands");
    expect(note.textContent).not.toMatch(/not connected|ready to generate|vector|export/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fixture.library.refresh).not.toHaveBeenCalled();
  });
  it("keeps the signed-out account gate instead of rendering private-library guidance", async () => {
    fixture.session.status = "signed_out";
    await act(async () => root.render(<AssetsWorkspace />));
    expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull();
    expect(host.querySelector(".assets-generation-note")).toBeNull();
    expect(fixture.useLibrary).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Settings capability-neutral guidance", () => {
  it.each(["ready", "unavailable", "signed_out"])("separates app connections from tool checks for a %s account", async status => {
    fixture.session.status = status;
    await act(async () => root.render(<SettingsWorkspace />));
    await act(async () => host.querySelector<HTMLButtonElement>("#settings-tab-integrations")!.click());
    const checks = host.querySelector('[aria-label="Availability checks"]')!;
    expect(checks.textContent).toContain("Availability checks are separate from connected apps");
    expect(checks.textContent).toContain("currently supported");
    expect(checks.textContent).toContain("trademark results are not legal clearance");
    expect(checks.textContent).not.toContain("not connected");
    expect([...checks.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual(["/domains", "/handles", "/trademarks"]);
    expect(host.querySelector('[aria-label="Connected apps"]')?.textContent).toContain("app connections are not available yet");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("directs image readiness to project logo workspaces without promising vector or export access", async () => {
    await act(async () => root.render(<SettingsWorkspace />));
    await act(async () => host.querySelector<HTMLButtonElement>("#settings-tab-ai")!.click());
    const images = host.querySelector('[aria-label="Images"]')!;
    expect(images.textContent).toContain("Logo concepts and saved-preview refinements have separate readiness checks");
    expect(images.textContent).toContain("Text readiness does not confirm image access");
    expect(images.querySelector("a")?.getAttribute("href")).toBe("/brands");
    expect(images.textContent).not.toMatch(/vector|export|not connected/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
