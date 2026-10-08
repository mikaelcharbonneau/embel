// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectionCard, type DirectionCardProps } from "@/features/identity-directions/components/direction-card";
import { renderDirectionGraphics } from "@/features/identity-directions/model/graphics";
import { directionFixture, id } from "./fixtures";

let host: HTMLDivElement, root: Root;
function props(): DirectionCardProps {
  const overview = directionFixture();
  return { direction: overview.directions[0]!, palette: overview.palettes[0]!, graphics: overview.graphics[0]!,
    typography: null, fonts: [], selectedParts: [], stale: false };
}
async function show(value: DirectionCardProps): Promise<void> {
  await act(async () => root.render(createElement(DirectionCard, value)));
}
function graphic(): HTMLImageElement | null {
  return host.querySelector('img[alt^="Supporting graphics for "]');
}
function svg(): string {
  const image = graphic();
  expect(image).not.toBeNull();
  const source = image!.getAttribute("src");
  expect(source).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  return decodeURIComponent(source!.split(",").slice(1).join(","));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("saved direction supporting graphics", () => {
  it("renders the existing deterministic SVG from exact saved specs and palette without changing the card data", async () => {
    const value = props();
    value.graphics!.elements = [
      { kind: "dots", paletteKey: "ink", radius: 2, spacing: 12 },
      { kind: "stripes", paletteKey: "paper", width: 3, spacing: 18, rotation: 30 },
      { kind: "shape", shape: "triangle", paletteKey: "ink", x: 20, y: 30, width: 40, height: 50 },
    ];
    const before = JSON.stringify(value);
    await show(value);
    expect(svg()).toBe(new TextDecoder().decode(renderDirectionGraphics(value.graphics!, value.palette!)));
    expect(svg()).toContain('fill="#191919"');
    expect(svg()).toContain('fill="#FFFFFF"');
    expect(svg()).not.toMatch(/(?:href|script|image|foreignObject)/i);
    expect(graphic()!.getAttribute("srcset")).toBeNull();
    expect(host.textContent).toContain("Preview of saved specifications");
    expect(host.textContent).toContain("Dots · radius 2, spacing 12");
    expect(host.textContent).toContain("Stripes · width 3, spacing 18, rotation 30°");
    expect(host.textContent).toContain("triangle · 40 × 50");
    expect(JSON.stringify(value)).toBe(before);
  });

  it("keeps validated empty specifications distinct from unavailable graphics", async () => {
    const value = props(); value.graphics!.elements = [];
    await show(value);
    expect(graphic()).toBeNull();
    expect(host.textContent).toContain("No supporting graphics are specified.");
    await show({ ...value, graphics: null });
    expect(graphic()).toBeNull();
    expect(host.textContent).toContain("Supporting graphics are unavailable.");
  });

  it("shows saved specifications but no substitute preview when the palette is missing", async () => {
    await show({ ...props(), palette: null });
    expect(graphic()).toBeNull();
    expect(host.textContent).toContain("Graphic preview unavailable");
    expect(host.textContent).toContain("saved palette");
    expect(host.textContent).toContain("Dots · radius 2, spacing 12");
  });

  it.each(["ownerId", "projectId", "approvedLogoId", "paletteVersionId", "graphicsVersionId"] as const)(
    "refuses a direction whose %s does not bind the supplied components", async field => {
      const value = props(); value.direction[field] = id(990);
      await show(value);
      expect(graphic()).toBeNull();
      expect(host.textContent).toContain("Graphic preview unavailable");
    },
  );

  it("refuses a direction with different input revisions even when graphics and palette agree", async () => {
    const value = props(); value.direction.inputRevisions = [{ stage: "vector", id: id(991), revision: 2 }];
    await show(value);
    expect(graphic()).toBeNull();
    expect(host.textContent).toContain("Graphic preview unavailable");
  });

  it("refuses graphics and palette from different saved bases", async () => {
    const value = props(); value.palette!.approvedLogoId = id(990);
    await show(value);
    expect(graphic()).toBeNull();
    expect(host.textContent).toContain("Graphic preview unavailable");
  });

  it.each([
    { kind: "dots", paletteKey: "ink", radius: 2, spacing: 0.001 },
    { kind: "shape", shape: "rectangle", paletteKey: "ink", x: 0, y: 0, width: 513, height: 1 },
    { kind: "dots", paletteKey: "absent", radius: 2, spacing: 12 },
    { kind: "image", paletteKey: "ink", url: "https://untrusted.invalid/image.svg" },
    { kind: "shape", shape: '<script>alert(1)</script>', paletteKey: "ink", x: 0, y: 0, width: 4, height: 4 },
  ])("keeps unsupported or unsafe specification %# unavailable", async element => {
    const value = props(); value.graphics!.elements = [element] as never;
    await show(value);
    expect(graphic()).toBeNull();
    expect(host.textContent).toContain("Graphic preview unavailable");
    expect(host.querySelector("script, iframe, object, image")).toBeNull();
    expect(host.innerHTML).not.toContain("https://untrusted.invalid");
  });

  it("preserves exact saved graphics for earlier inputs and labels the preview as historical", async () => {
    const value = props(); value.stale = true;
    await show(value);
    expect(svg()).toBe(new TextDecoder().decode(renderDirectionGraphics(value.graphics!, value.palette!)));
    expect(graphic()!.alt).toContain("earlier inputs");
    expect(host.textContent).toContain("Earlier inputs");
  });

  it("shows a display failure honestly and resets it only for a different saved preview", async () => {
    const first = props(); await show(first);
    const firstImage = graphic(); expect(firstImage).not.toBeNull();
    await act(async () => firstImage!.dispatchEvent(new Event("error")));
    expect(graphic()).toBeNull();
    expect(host.textContent).toContain("Graphic preview unavailable");
    expect(host.textContent).not.toContain("Preview of saved specifications");
    expect(host.textContent).toContain("Dots · radius 2, spacing 12");
    await show({ ...first, stale: true });
    expect(graphic()).toBeNull();

    const next = props(); next.direction.id = id(901); next.graphics!.id = id(902); next.direction.graphicsVersionId = id(902);
    await show(next);
    expect(graphic()).not.toBeNull();
    await act(async () => firstImage!.dispatchEvent(new Event("error")));
    expect(graphic()).not.toBeNull();
  });

  it("replaces the visible SVG when accepted saved data changes and removes it when data disappears", async () => {
    const first = props(); await show(first); const before = svg();
    const next = props(); next.graphics!.elements = [{ kind: "stripes", paletteKey: "ink", width: 6, spacing: 24, rotation: -45 }];
    await show(next);
    expect(svg()).not.toBe(before); expect(svg()).toContain('rotate(-45)');
    await show({ ...next, graphics: null });
    expect(graphic()).toBeNull(); expect(host.innerHTML).not.toContain("data:image/svg+xml");
  });
});
