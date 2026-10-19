import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { inspirationCatalog, type InspirationChoice } from "../../src/domain/inspiration";
import { brandBoardDirection, contrastRatio } from "../../src/components/logo-creation/brand-board-direction";
import { BrandBoardSystem } from "../../src/components/logo-creation/brand-board-system";
const choice = (tag: string, elements: InspirationChoice["elements"] = ["colors"]): InspirationChoice => ({ referenceId: inspirationCatalog.find(row => row.tags.includes(tag))!.id, ensemble: false, elements } as InspirationChoice);
describe("brand board proposal", () => {
  it("derives its primary and accent from actual saved color choices", () => {
    const board = brandBoardDirection([choice("red"), choice("blue")], "wordmark");
    expect(board.primary.hex).toBe("#2454DB");
    expect(board.accent.hex).toBe("#CF3438");
    expect(brandBoardDirection([choice("red")], "wordmark").primary.hex).toBe("#CF3438");
    expect(board.references).toHaveLength(2);
  });
  it("does not interpret a typography-only like as color approval", () => {
    expect(brandBoardDirection([choice("red", ["typography"])], "wordmark").primary.name).toBe("Ink");
    expect(brandBoardDirection([], "wordmark").references).toHaveLength(0);
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
    expect(html).toContain("Color palette");
    expect(html).toContain("Typography");
    expect(html).toContain("Business card");
    expect(html).toContain("Social announcement");
    expect(html).toContain("Website landing page");
    expect(html.match(/Exact selected logo/g)).toHaveLength(4);
    expect(html).not.toContain("Design notes");
    expect(html).not.toContain("Make your");
    expect(html).not.toContain("Start something");
    expect(html).not.toContain("Ideas into possibilities");
    expect(html).toContain("Heading ·");
    expect(html).toContain("Body · Regular 400");
    expect(html).toContain("Primary");
    expect(html).toContain("Accent");
    expect(html.match(/Brand tools/g)).toHaveLength(2);
  });
});
