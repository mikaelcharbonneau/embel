// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { inspirationCatalog, type InspirationChoice } from "../../src/domain/inspiration";
import { brandBoardDirection, brandBoardLogoNeedsReview, contrastRatio } from "../../src/components/logo-creation/brand-board-direction";
import { BrandBoardSystem } from "../../src/components/logo-creation/brand-board-system";
import type { LogoRasterSource, LogoStage } from "../../src/domain/logo-workspace";
const choice = (tag: string, elements: InspirationChoice["elements"] = ["colors"]): InspirationChoice => ({ referenceId: inspirationCatalog.find(row => row.tags.includes(tag))!.id, ensemble: false, elements } as InspirationChoice);
describe("brand board proposal", () => {
  it("derives its primary and accent from actual saved color choices", () => {
    const board = brandBoardDirection([choice("red"), choice("blue")], "wordmark");
    expect(board.primary.hex).toBe("#2454DB");
    expect(board.accent.hex).toBe("#CF3438");
    expect(brandBoardDirection([choice("red")], "wordmark").primary.hex).toBe("#CF3438");
    expect(board.references).toHaveLength(2);
    expect(board.status).toBe("proposal");
    expect(board.paletteSource).toBe("saved_inspiration");
    expect(board.type).toMatchObject({ source: "preview_default", family: "Geist Sans" });
  });
  it("does not interpret a typography-only like as color approval", () => {
    expect(brandBoardDirection([choice("red", ["typography"])], "wordmark").primary.name).toBe("Ink");
    expect(brandBoardDirection([choice("red", ["typography"])], "wordmark").paletteSource).toBe("neutral_default");
    expect(brandBoardDirection([], "wordmark").references).toHaveLength(0);
    expect(brandBoardDirection([], "wordmark").status).toBe("proposal");
  });
  it("verifies every recommended text/background pair and responds to the selected logo type", () => {
    for (const tag of ["blue", "red", "green", "pink"]) {
      for (const color of brandBoardDirection([choice(tag)], "wordmark").palette) expect(contrastRatio(color.hex, color.foreground)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio("#FFFFFF", "#000000")).toBe(21);
    expect(brandBoardDirection([], "abstract").type.headingWeight).toBe(700);
    expect(brandBoardDirection([], "wordmark").type.headingWeight).toBe(600);
  });
  it("renders all three application concepts with the supplied logo and does not claim approved outputs", () => {
    const html = renderToStaticMarkup(createElement(BrandBoardSystem, { name: "Glide", activity: "Brand tools", logoType: "wordmark", choices: [choice("blue")], logo: createElement("span", null, "Exact selected logo") }));
    expect(html).toContain("Proposed palette");
    expect(html).toContain("From saved inspiration");
    expect(html).toContain("Proposed typography");
    expect(html).toContain("Geist Sans · Default preview");
    expect(html).toContain("Saved selection");
    expect(html).toContain("Business card");
    expect(html).toContain("Social announcement");
    expect(html).toContain("Website landing page");
    expect(html.match(/Exact selected logo/g)).toHaveLength(4);
    expect(html.match(/Application preview/g)).toHaveLength(3);
    expect(html).not.toMatch(/\b(?:approved|final|exports?|download|licensed|generated)\b/i);
    expect(html).not.toContain("Design notes");
    expect(html).not.toContain("Brand audience");
    expect(html).not.toContain("Review board");
    expect(html).not.toContain("Dropbox");
    expect(html).not.toContain("Make your");
    expect(html).not.toContain("Start something");
    expect(html).not.toContain("Ideas into possibilities");
    expect(html).toContain("Heading ·");
    expect(html).toContain("Body · Regular 400");
    expect(html).toContain("Primary");
    expect(html).toContain("Accent");
    expect(html.match(/Brand tools/g)).toHaveLength(2);
    const document = new DOMParser().parseFromString(html, "text/html");
    const tiles = [...document.querySelectorAll("[data-brand-board-layout] > section")];
    expect(tiles).toHaveLength(6);
    for (const tile of tiles) {
      const description = document.getElementById(tile.getAttribute("aria-describedby")!);
      expect(description?.textContent).toBeTruthy();
      const labelId = tile.getAttribute("aria-labelledby");
      expect(labelId ? document.getElementById(labelId)?.tagName : tile.getAttribute("aria-label")).toBeTruthy();
    }
    expect(document.getElementById("board-palette")?.textContent).toBe("Proposed palette");
    expect(document.getElementById("board-type")?.textContent).toBe("Proposed typography");
    expect(document.querySelector('[role="alert"], [role="status"]')).toBeNull();
  });
  it("uses a neutral proposal without attributing it to absent saved color inspiration", () => {
    const choices: InspirationChoice[] = [];
    const before = structuredClone(choices);
    const board = brandBoardDirection(choices, "wordmark");
    const html = renderToStaticMarkup(createElement(BrandBoardSystem, { name: "Glide", activity: "", logoType: "wordmark", choices, logo: "Exact selected logo" }));
    expect(html).toContain("Neutral starting point");
    expect(html).not.toContain("From saved inspiration");
    expect(board.paletteSource).toBe("neutral_default");
    expect(brandBoardDirection(choices, "wordmark")).toEqual(board);
    expect(choices).toEqual(before);
  });
  it("keeps stale selection guidance inside the logo tile without a review banner", () => {
    const html = renderToStaticMarkup(createElement(BrandBoardSystem, { name: "Glide", activity: "", logoType: "wordmark", choices: [], logo: "Exact saved logo", logoNeedsReview: true }));
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector('[aria-label="Selected brand logo"]')?.textContent).toContain("Saved selection · Review changed inputs");
    expect(document.querySelectorAll("[data-brand-board-layout] > section")).toHaveLength(6);
    expect(html.match(/Exact saved logo/g)).toHaveLength(4);
    expect(html).not.toMatch(/\b(?:approved|final|exports?|download)\b/i);
    expect(document.querySelector('[role="alert"], [role="status"]')).toBeNull();
  });
  it("limits review guidance to the saved raster's actual input stages", () => {
    const concept = { kind: "concept" } as LogoRasterSource;
    const refinement = { kind: "refinement" } as LogoRasterSource;
    const stale = (stage: LogoStage) => [{ stage, reasons: ["input_revision_changed"] }];
    expect(brandBoardLogoNeedsReview([], concept)).toBe(false);
    for (const stage of ["brief_references", "concepts"] as const) {
      expect(brandBoardLogoNeedsReview(stale(stage), concept)).toBe(true);
      expect(brandBoardLogoNeedsReview(stale(stage), refinement)).toBe(true);
    }
    expect(brandBoardLogoNeedsReview(stale("refinements"), concept)).toBe(false);
    expect(brandBoardLogoNeedsReview(stale("refinements"), refinement)).toBe(true);
    for (const stage of ["vector", "directions", "deliverables"] as const) {
      expect(brandBoardLogoNeedsReview(stale(stage), concept)).toBe(false);
      expect(brandBoardLogoNeedsReview(stale(stage), refinement)).toBe(false);
    }
  });
});
