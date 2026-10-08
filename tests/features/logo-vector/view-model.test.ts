import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LogoEditorPresentation } from "../../../src/features/logo-vector/components/logo-editor";
import { separatedLogoDocument } from "./fixtures";

const props = () => ({ document: separatedLogoDocument(), selectedComponentId: "synthetic-symbol", lockedComponentIds: [], onSelectComponent: () => {}, onEdit: () => {}, history: null });
describe("unmounted local editor presentation", () => {
  it("reserves a bounded canonical preview beside an honest missing original and unavailable account actions", () => {
    const html = renderToStaticMarkup(createElement(LogoEditorPresentation, { ...props(), mode: "review_required" }));
    expect(html).toContain('aria-label="Vector candidate"');
    expect(html).not.toContain("<path");
    expect(html).toContain("Preparing the vector preview");
    expect(html).toContain("Review required");
    expect(html).toContain("Original preview unavailable");
    expect(html).toContain("Saved history unavailable");
    expect(html).toContain("Save edit");
    expect(html).toContain("Accept this vector");
    expect(html).toContain("Refine with AI");
    expect(html).toContain("Local preview — unsaved");
    expect(html).not.toContain("<image");
    expect(html).not.toContain("href=");
  });
  it.each(["stale", "conflict", "read_only"] as const)("retains the current document in %s mode without claiming a successful save", mode => {
    const html = renderToStaticMarkup(createElement(LogoEditorPresentation, { ...props(), mode }));
    expect(html).toContain('aria-label="Vector candidate"');
    expect(html).toContain(mode === "stale" ? "Earlier input version" : mode === "conflict" ? "Revision conflict" : "Read-only preview");
    expect(html).toContain("Saving is unavailable");
  });
  it("renders no SVG for unavailable or invalid input", () => {
    const unavailable = renderToStaticMarkup(createElement(LogoEditorPresentation, { ...props(), document: null, mode: "unavailable" }));
    expect(unavailable).not.toContain("<svg");
    const document = separatedLogoDocument();
    document.components[0]!.paths[0]!.d = '<script>alert(1)</script>';
    const invalid = renderToStaticMarkup(createElement(LogoEditorPresentation, { ...props(), document, mode: "review_required" }));
    expect(invalid).not.toContain("<svg");
    expect(invalid).not.toContain("<script");
    expect(invalid).toContain("Vector preview unavailable");
  });
});
