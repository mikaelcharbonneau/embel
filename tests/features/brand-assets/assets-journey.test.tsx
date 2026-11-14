// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brandAssetFixture, logoBytes } from "./fixtures";
import { contextSnapshotSchema, type ContextSnapshot } from "../../../src/domain/projects";
import { brandBoardContrastRatio } from "../../../src/domain/brand-board-design";
import type { PreparedBrandAssets } from "../../../src/features/brand-assets/client/build-pack";
import { AssetsJourney } from "../../../src/features/brand-assets/components/assets-journey";
import { brandGuideHtml } from "../../../src/features/brand-assets/model/guides";
import { ToastProvider } from "../../../src/components/ui/toast";

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const slogan = "From idea to identity.";
function context(): ContextSnapshot {
  const base = contextSnapshotSchema.parse({});
  return {
    ...base,
    positioning: "For founders preparing to launch, a branding app.",
    competitors: [
      { id: "70000000-0000-4000-8000-000000000001", name: "Looka", selected: true },
    ] as unknown as ContextSnapshot["competitors"],
    personality: { sincerity: 90, excitement: 20, competence: 80, sophistication: 10, ruggedness: 5 },
    intake: {
      ...base.intake,
      guidedInterview: {
        answers: [{ stage: "slogan", customText: slogan }],
      } as unknown as ContextSnapshot["intake"]["guidedInterview"],
    },
  };
}
const file = (
  name: string,
  category: "board" | "logo" | "social" | "guide",
  mimeType = "image/png",
  editable = false,
  label = name,
) => ({ name, label, category, mimeType, bytes: logoBytes, editable });
async function render(options: { status?: string; pack?: PreparedBrandAssets | null; preparing?: boolean } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        return "blob:local";
      }
      static revokeObjectURL() {}
    },
  );
  const f = brandAssetFixture();
  const pack: PreparedBrandAssets = {
    files: [
      file("brand-board.png", "board"),
      file("logo/logo-original.png", "logo"),
      file("social/profile.png", "social", "image/png", false, "Profile image"),
      file("social/post-square.png", "social", "image/png", false, "Square post template"),
      file("social/post-square.svg", "social", "image/svg+xml", true, "Square post template"),
      { ...file("guides/brand-guide.html", "guide", "text/html"), bytes: brandGuideHtml(f.snapshot) },
    ],
    getArchive: () => new Uint8Array(),
    vectorIncluded: false,
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const downloadFile = vi.fn(),
    onRetry = vi.fn();
  const shown = options.pack === undefined ? pack : options.pack;
  await act(async () =>
    root!.render(
      createElement(
        ToastProvider,
        null,
        createElement(AssetsJourney, {
          snapshot: f.snapshot,
          pack: shown,
          previews: new Map([["brand-board.png", "blob:board"]]),
          downloadFile,
          disabled: false,
          projectId: f.projectId,
          context: context(),
          directionTitle: "Room to Begin",
          status: options.status ?? "Ready to download.",
          preparing: options.preparing ?? !shown,
          onRetry,
        }),
      ),
    ),
  );
  const buttons = () => [...container.querySelectorAll("button")];
  const named = (label: string) =>
    buttons().find((button) => (button.getAttribute("aria-label") ?? button.textContent)?.trim() === label);
  return { container, snapshot: f.snapshot, pack, downloadFile, onRetry, buttons, named };
}

describe("Assets delivery page", () => {
  it("is one page: the brand's name, the kit button always in view and three tabs", async () => {
    const { container, named } = await render();
    expect(container.querySelector("h1")?.textContent).toBe("Northline");
    expect(container.textContent).toContain("Your brand kit, made from your logo and your direction, Room to Begin.");
    const tabs = [...container.querySelectorAll("[role=tab]")];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Brand images", "Brand guidelines", "Design system"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    const kit = named("Download brand kit")!;
    expect(kit.className).toContain("e-button--primary");
    expect(kit.disabled).toBe(false);
    expect(container.textContent).toContain("Logo files, images, guidelines and tokens · ZIP · 6 files");
    expect([...container.querySelectorAll("[role=status]")].map((node) => node.textContent)).toContain(
      "Ready to download.",
    );
    // No conversation stepping once the brand is complete.
    expect(container.textContent).not.toContain("Continue");
    const panels = [...container.querySelectorAll("[role=tabpanel]")];
    expect(panels.map((panel) => (panel as HTMLElement).hidden)).toEqual([false, true, true]);
    await act(async () => (tabs[2] as HTMLButtonElement).click());
    expect([...container.querySelectorAll("[role=tabpanel]")].map((panel) => (panel as HTMLElement).hidden)).toEqual([
      true,
      true,
      false,
    ]);
    await act(async () =>
      tabs[2]!.parentElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("names every download by what it holds and passes the file", async () => {
    const { named, downloadFile, container } = await render();
    const board = named("Download PNG: brand board")!;
    expect(board.textContent).toBe("Download PNG");
    expect(container.querySelector("img[alt='Northline final brand board']")).not.toBeNull();
    await act(async () => board.click());
    expect(downloadFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: "brand-board.png" }));
    await act(async () => named("Download PNG: profile image")!.click());
    expect(downloadFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: "social/profile.png" }));
    // Posts and banners offer the PNG and the editable SVG in one menu.
    await act(async () => named("Download square post template")!.click());
    const items = [...container.querySelectorAll("[role=menuitem]")];
    expect(items.map((item) => item.textContent)).toEqual(["PNG image", "SVG you can edit"]);
    await act(async () => (items[1] as HTMLButtonElement).click());
    expect(downloadFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: "social/post-square.svg" }));
    await act(async () => named("Download guidelines")!.click());
    expect(downloadFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: "guides/brand-guide.html" }));
    await act(async () => named("Download brand kit")!.click());
    expect(downloadFile).toHaveBeenLastCalledWith();
  });

  it("shows the guidelines file itself on the page", async () => {
    const { container } = await render();
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("title")).toBe("Northline brand guidelines");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Brand guidelines</h1>");
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual(
      expect.arrayContaining(["Logo", "Creative direction", "Voice"]),
    );
  });

  it("while images are prepared, keeps the kit button working and says what is ready", async () => {
    const { container, buttons, downloadFile } = await render({ pack: null, status: "Preparing your files…" });
    const kit = buttons().find((button) => button.textContent === "Preparing brand kit")!;
    expect(kit.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("The brand kit can be downloaded when your brand images are ready.");
    expect(container.textContent).toContain("Your design system is ready now.");
    await act(async () => kit.click());
    expect(downloadFile).toHaveBeenCalledWith();
  });

  it("names images that could not be prepared and retries them", async () => {
    const { pack } = await render();
    await act(async () => root!.unmount());
    root = null;
    const { container, named, onRetry } = await render({
      pack: {
        ...pack,
        files: pack.files.filter((item) => !item.name.startsWith("social/banner")),
        failed: [
          { name: "social/banner-wide", label: "Wide banner" },
          { name: "social/banner-cover", label: "Cover banner" },
        ],
      },
    });
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "Two brand images couldn’t be prepared: the wide banner and the cover banner. Everything else is ready.",
    );
    expect(container.textContent).toContain("Logo files, 4 of 6 images, guidelines and tokens");
    expect(container.textContent).toContain("This image couldn’t be prepared.");
    await act(async () => named("Retry 2 images")!.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps design-system preview text readable when the accent is too light for text", async () => {
    const { container, snapshot } = await render();
    const highlight = container.querySelector("[data-accent]") as HTMLElement;
    expect(highlight.dataset.accent).toBe("fill");
    expect(highlight.textContent).toBe(snapshot.name);
    const hex = (rgb: string) =>
      `#${rgb
        .match(/\d+/gu)!
        .map((value) => Number(value).toString(16).padStart(2, "0"))
        .join("")}`;
    expect(hex(highlight.style.background).toUpperCase()).toBe(snapshot.palette.accent);
    expect(brandBoardContrastRatio(hex(highlight.style.color), snapshot.palette.accent)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("brand guidelines document", () => {
  it("is written in plain American English from saved content only", () => {
    const f = brandAssetFixture();
    const snapshot = { ...f.snapshot, typeNotes: "Set brand_body at 16 px." };
    const guide = new TextDecoder().decode(
      brandGuideHtml(snapshot, {
        slogan,
        positioning: "For founders preparing to launch, a branding app.",
        traits: ["sincerity", "competence"],
        direction: "Room to Begin",
        date: new Date("2026-11-13T12:00:00Z"),
      }),
    );
    expect(guide).not.toMatch(/colour/iu);
    expect(guide).not.toContain("Looka");
    expect(guide).toContain("Set brand body at 16 px.");
    expect(guide).not.toContain("brand_body");
    expect(guide).toContain("<strong>Leads with sincerity and competence.</strong>");
    expect(guide).toContain(`<p>${slogan}</p>`);
    expect(guide).toContain("Room to Begin · November 2026");
    // Lines that were never saved are left out, never invented.
    expect(guide).not.toMatch(/\[|placeholder|Not this/iu);
    expect(guide).not.toContain('id="g-logo"');
  });
  it("shows the logo on light and dark, the do-nots and the direction's details when the pictures exist", () => {
    const f = brandAssetFixture();
    const png = "data:image/png;base64,AAAA",
      jpeg = "data:image/jpeg;base64,BBBB";
    const guide = new TextDecoder().decode(
      brandGuideHtml(f.snapshot, { images: { logo: png, logoReversed: png, crops: [jpeg, jpeg, jpeg] } }),
    );
    expect(guide).toContain('aria-label="Northline logo"');
    expect(guide).toContain('aria-label="Northline logo, reversed"');
    expect(guide).toContain("Don’t stretch or squeeze it.");
    expect(guide.match(/<img src="data:image\/jpeg/gu)).toHaveLength(3);
    expect(guide).toContain("Pairs for text");
    // A picture that is not an image data URL is never written into the file.
    expect(
      new TextDecoder().decode(brandGuideHtml(f.snapshot, { images: { logo: "javascript:alert(1)" } })),
    ).not.toContain("javascript:");
  });
});
