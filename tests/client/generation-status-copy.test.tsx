// @vitest-environment jsdom
import { act } from "react";
import Link from "next/link";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetsWorkspace } from "@/components/assets/assets-workspace";
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
vi.mock("@/components/assets/use-asset-library", () => ({
  useAssetLibrary: () => {
    fixture.useLibrary();
    return fixture.library;
  },
}));
vi.mock("@/components/assets/asset-detail", () => ({ AssetDetailDialog: () => null }));
vi.mock("@/components/assets/asset-preview", () => ({ AssetPreview: () => null }));
vi.mock("@/components/workspace/account-profile-editor", () => ({ AccountProfileEditor: () => null }));
vi.mock("@/components/workspace/account-access", () => ({ useSignOutFlow: () => ({ start: vi.fn(), dialog: null }) }));
vi.mock("@/components/workspace/recorded-usage", () => ({ RecordedUsageSection: () => null }));

let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  fixture.session = { status: "ready", userId: "fixture-owner", generation: 1 };
  fixture.useLibrary.mockClear();
  fixture.library = {
    query: { tab: "my_selection" },
    page: { items: [], nextCursor: null },
    projects: [],
    status: "ready",
    busy: false,
    error: null,
    refresh: vi.fn(),
    changeQuery: vi.fn(),
  } as unknown as ReturnType<typeof useAssetLibrary>;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

// Capability-neutral guidance must not probe a provider or infer readiness from
// an unrelated library load or app-connection state.
describe("Assets generation guidance", () => {
  it.each(["ready", "loading", "error"] as const)(
    "shows a clean gallery without system notes or a generation claim when library is %s",
    async (status) => {
      fixture.library = {
        ...fixture.library,
        status,
        error: status === "error" ? "Assets could not be loaded." : null,
      };
      await act(async () => root.render(<AssetsWorkspace />));
      expect(host.querySelector(".assets-generation-note")).toBeNull();
      expect(host.textContent).not.toMatch(
        /Kept assets includes|Versions stay in your library|Available operations|already saved in your account|File checked/,
      );
      expect(host.textContent).not.toMatch(/not connected|ready to generate|vector|export/i);
      expect(fetcher).not.toHaveBeenCalled();
      expect(fixture.library.refresh).not.toHaveBeenCalled();
    },
  );
  it("keeps the signed-out account gate instead of rendering private-library guidance", async () => {
    fixture.session.status = "signed_out";
    await act(async () => root.render(<AssetsWorkspace />));
    expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull();
    expect(host.querySelector(".assets-generation-note")).toBeNull();
    expect(fixture.useLibrary).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
