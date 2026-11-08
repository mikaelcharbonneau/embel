// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brandAssetFixture, logoBytes } from "./fixtures";
import { contextSnapshotSchema, type ContextSnapshot } from "../../../src/domain/projects";
import { brandBoardContrastRatio } from "../../../src/domain/brand-board-design";
import type { PreparedBrandAssets } from "../../../src/features/brand-assets/client/build-pack";
import { AssetsJourney } from "../../../src/features/brand-assets/components/assets-journey";

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; document.body.replaceChildren(); vi.unstubAllGlobals();
});

const slogan = "From idea to identity.";
function context(): ContextSnapshot {
  const base = contextSnapshotSchema.parse({});
  return { ...base, positioning: "For founders preparing to launch, a branding app.",
    competitors: [{ id: "70000000-0000-4000-8000-000000000001", name: "Looka", selected: true }] as unknown as ContextSnapshot["competitors"],
    personality: { sincerity: 90, excitement: 20, competence: 80, sophistication: 10, ruggedness: 5 },
    intake: { ...base.intake, guidedInterview: { answers: [{ stage: "slogan", customText: slogan }] } as unknown as ContextSnapshot["intake"]["guidedInterview"] } };
}
async function render(options: { status?: string } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", class extends URL { static createObjectURL() { return "blob:local"; } static revokeObjectURL() {} });
  const f = brandAssetFixture(), file = (name: string, category: "board" | "logo" | "social" | "guide", mimeType = "image/png", editable = false) => ({ name, label: name, category, mimeType, bytes: logoBytes, editable });
  const pack: PreparedBrandAssets = { files: [
    file("brand-board.png", "board"), file("logo/logo-original.png", "logo"), file("logo/logo-transparent.png", "logo"), file("logo/logo-reversed.png", "logo"),
    file("social/post-square.png", "social"), file("social/post-square.svg", "social", "image/svg+xml", true),
    file("guides/brand-guide.html", "guide", "text/html"),
  ], getArchive: () => new Uint8Array(), vectorIncluded: false };
  const snapshot = { ...f.snapshot, typeNotes: "Set brand_body at 16 px." };
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const downloadFile = vi.fn();
  await act(async () => root!.render(createElement(AssetsJourney, { snapshot, pack, previews: new Map(), downloadFile, disabled: false, projectId: f.projectId,
    context: context(), directionTitle: "Room to Begin", status: options.status ?? "Ready to download." })));
  return { container, snapshot, downloadFile };
}

describe("Assets step presentation", () => {
  it("opens with a kit summary and labels each message and card by what it holds", async () => {
    const { container } = await render();
    const kits = [...container.querySelectorAll("button")].filter(button => button.textContent === "Download brand kit");
    expect(kits).toHaveLength(2); kits.forEach(button => expect(button.className).toBe("button primary"));
    expect(kits[0]!.getAttribute("aria-label")).toBeNull();
    expect(container.querySelector("[role=status]")?.textContent).toBe("Ready to download.");
    expect(container.textContent).toContain("Logo files, brand images, guidelines and design tokens for Northline, in your chosen direction, Room to Begin.");
    expect(container.querySelector("article[aria-label='Brand images'] .guided-assistant-copy")?.textContent).toContain("Here are your brand images in your chosen direction, Room to Begin: a brand board");
    const headings = [...container.querySelectorAll("h2")];
    expect(headings.map(heading => heading.textContent)).toEqual(["Your brand kit", "Brand board", "Social images and templates", "Brand guidelines", "Design system"]);
    expect(headings.some(heading => heading.classList.contains("sr-only"))).toBe(false);
  });

  it("names downloads clearly and uses the shared pill buttons", async () => {
    const { container, downloadFile } = await render();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some(button => button.className.includes("kit-button"))).toBe(false);
    const png = buttons.find(button => button.getAttribute("aria-label") === "Download square post template as PNG")!;
    expect(png.textContent).toBe("Download PNG"); expect(png.className).toBe("button secondary small");
    expect(buttons.find(button => button.getAttribute("aria-label") === "Download square post template as editable SVG")?.textContent).toBe("Download SVG");
    expect(buttons.find(button => button.getAttribute("aria-label") === "Download brand board as PNG")?.textContent).toBe("Download PNG");
    expect(buttons.filter(button => /logo/u.test(button.textContent ?? "")).map(button => button.textContent)).toEqual(["Download logo PNG", "Download transparent logo PNG", "Download reversed logo PNG"]);
    await act(async () => buttons.find(button => button.textContent === "Download reversed logo PNG")!.click());
    expect(downloadFile).toHaveBeenCalledWith(expect.objectContaining({ name: "logo/logo-reversed.png" }));
  });

  it("writes guidelines in plain American English from saved content only", async () => {
    const { container } = await render();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/colour/iu); expect(text).not.toContain("Compared with"); expect(text).not.toContain("Looka");
    expect(text).toContain("Set brand body at 16 px."); expect(text).not.toContain("brand_body");
    expect(container.querySelector("#g-voice p")?.textContent).toBe(`Leads with sincerity and competence, as in “${slogan}”`);
    expect([...container.querySelectorAll(".kit-sections a")].map(link => link.getAttribute("href"))).toContain("#g-colors");
    const tiles = [...container.querySelectorAll("#g-logo figure")];
    expect(tiles.map(tile => tile.querySelector("figcaption")?.textContent)).toEqual(["On light backgrounds", "Reversed version, for dark backgrounds"]);
    expect(tiles[1]!.querySelector("img")?.getAttribute("alt")).toBe("Northline logo, one-color reversed version on Forest");
  });

  it("keeps design-system preview text readable when the accent is too light for text", async () => {
    const { container, snapshot } = await render();
    expect(container.querySelector(".kit-preview-accent")).toBeNull();
    const highlight = [...container.querySelectorAll(".kit-preview span")].find(node => node.textContent === snapshot.name) as HTMLElement;
    const hex = (rgb: string) => `#${rgb.match(/\d+/gu)!.map(value => Number(value).toString(16).padStart(2, "0")).join("")}`;
    expect(hex(highlight.style.background).toUpperCase()).toBe(snapshot.palette.accent);
    expect(brandBoardContrastRatio(hex(highlight.style.color), snapshot.palette.accent)).toBeGreaterThanOrEqual(4.5);
  });
});
