import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LogoRefinementGallery } from "../../src/components/logo-creation/refinement-gallery";
import { LogoCostConfirmationView } from "../../src/components/logo-creation/cost-confirmation";
import { syntheticRasterRefinement } from "../fixtures/logo-refinement-history";
import { syntheticLogoQuote, logoFixtureId as id } from "../fixtures/logo-creation";
import type { LogoRasterSource } from "../../src/domain/logo-workspace";
import type { LogoRefinementHistoryState } from "../../src/components/logo-creation/refinement-history";
const record = syntheticRasterRefinement(), source = { kind: "refinement" as const, rasterRevisionId: record.id };
const history = (changes: Partial<LogoRefinementHistoryState> = {}): LogoRefinementHistoryState => ({ items: [{ record, verified: true, error: null }], nextCursor: null, loaded: true, loading: false, error: null, ...changes });
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] { return Children.toArray(node).flatMap(child => !isValidElement<Record<string, unknown>>(child) ? [] : [child, ...elements(child.props.children as ReactNode)]); }
function button(node: ReactNode, name: string) { const found = elements(node).find(child => child.type === "button" && child.props["aria-label"] === name); if (!found) throw new Error(`Missing button ${name}`); return found; }
const selectName = `Select image refinement ${record.id}`;
const markup = (node: ReactNode) => renderToStaticMarkup(node);

describe("refined raster history presentation", () => {
  it("explicitly selects the exact verified refinement with its original source and charge", () => {
    const selections: LogoRasterSource[] = [];
    const node = LogoRefinementGallery({ history: history(), onSelect: item => selections.push(item) });
    expect(selections).toEqual([]); expect(button(node, selectName).props.disabled).toBe(false);
    (button(node, selectName).props.onClick as () => void)(); expect(selections).toEqual([source]);
    const html = markup(node);
    expect(html).toContain("Saved image refinements"); expect(html).toContain("Confirmed charge: $0.10");
    expect(html).toContain(record.source.kind === "concept" ? record.source.attemptId : "missing");
    expect(html).toContain("Wordmark"); expect(html).toContain("Vector conversion and approval follow separately");
  });
  it("successful inspection and selection do not depend on generation availability", () => {
    const node = LogoRefinementGallery({ history: history(), selected: source, onSelect: () => undefined, refinementAvailable: false,
      renderPreview: receipt => createElement("span", null, receipt.reference.contentHash), onRequestRefine: () => undefined });
    expect(markup(node)).toContain(record.preview!.reference.contentHash);
    expect(button(node, selectName).props.disabled).toBe(false); expect(button(node, selectName).props["aria-pressed"]).toBe(true);
    expect(button(node, "Refine selected image refinement").props.disabled).toBe(true);
  });
  it("unverified details remain visible with selection disabled and no unverified preview", () => {
    const node = LogoRefinementGallery({ history: history({ items: [{ record, verified: false, error: "Saved details unavailable." }] }), onSelect: () => undefined,
      renderPreview: () => createElement("span", null, "SHOULD NOT DISPLAY") });
    expect(button(node, selectName).props.disabled).toBe(true); expect(markup(node)).toContain("Saved details unavailable"); expect(markup(node)).not.toContain("SHOULD NOT DISPLAY");
  });
  it("uncertain saved images retain unknown billing without selection or a free-charge claim", () => {
    const uncertain = syntheticRasterRefinement({ state: "needs_reconciliation", reason: "billing_unknown", billing: { status: "unknown", confirmedMicrousd: null } });
    const node = LogoRefinementGallery({ history: history({ items: [{ record: uncertain, verified: true, error: null }] }), onSelect: () => undefined });
    expect(markup(node)).toContain("Outcome uncertain"); expect(markup(node)).toContain("Charge not confirmed"); expect(markup(node)).not.toContain("$0");
    expect(button(node, selectName).props.disabled).toBe(true);
  });
  it("earlier brief history is retained with an explicit warning", () => {
    const node = LogoRefinementGallery({ history: history(), briefRevisionId: id(990), onSelect: () => undefined });
    expect(markup(node)).toContain("Uses an earlier saved brief"); expect(button(node, selectName).props.disabled).toBe(false);
  });
  it("shows delivery failure with retained usage and keeps the missing refinement unselectable", () => {
    const failed = syntheticRasterRefinement({ state: "failed", reason: "logo_image_unavailable", preview: null });
    const node = LogoRefinementGallery({ history: history({ items: [{ record: failed, verified: true, error: null }] }), onSelect: () => undefined });
    expect(markup(node)).toContain("This refinement could not be saved.");
    expect(markup(node)).toContain("AI usage is still recorded.");
    expect(markup(node)).not.toContain("Outcome uncertain");
    expect(button(node, selectName).props.disabled).toBe(true);
  });
  it("page loading and failed refresh leave good cards visible", () => {
    const node = LogoRefinementGallery({ history: history({ loading: true, error: "History could not be refreshed.", nextCursor: "older" }), onRefresh: () => undefined, onLoadMore: () => undefined });
    expect(markup(node)).toContain(record.id); expect(markup(node)).toContain("History could not be refreshed");
    expect(button(node, "Refresh saved image refinements").props.disabled).toBe(true); expect(button(node, "Load older image refinements").props.disabled).toBe(true);
  });
  it("further refinement opens cost review for the saved exact selection only", () => {
    const requests: LogoRasterSource[] = [];
    const node = LogoRefinementGallery({ history: history(), selected: source, refinementAvailable: true, onRequestRefine: item => requests.push(item) });
    expect(requests).toEqual([]); (button(node, "Refine selected image refinement").props.onClick as () => void)(); expect(requests).toEqual([source]);
  });
  it("cost confirmation identifies the exact quoted refinement even if current selection differs", () => {
    const quote = { ...syntheticLogoQuote(), conceptPlan: null, targetSlotIds: [], request: { operation: "refine_preview" as const, source, expected: syntheticLogoQuote().expected, instruction: "Simplify" } };
    const html = markup(createElement(LogoCostConfirmationView, { quote }));
    expect(html).toContain(`Saved image refinement · ${record.id}`); expect(html).toContain("Refine this image refinement");
  });
});
