// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { inspirationCatalog, type InspirationChoice } from "../../src/domain/inspiration";
import { brandBoardDirection, brandBoardLogoNeedsReview, contrastRatio } from "../../src/components/logo-creation/brand-board-direction";
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
  it("keeps neutral proposal calculation deterministic without mutating saved choices", () => {
    const choices: InspirationChoice[] = [], before = structuredClone(choices);
    const board = brandBoardDirection(choices, "wordmark");
    expect(board.paletteSource).toBe("neutral_default");
    expect(brandBoardDirection(choices, "wordmark")).toEqual(board);
    expect(choices).toEqual(before);
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
