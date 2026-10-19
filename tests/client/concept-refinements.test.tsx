import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConceptRefinements } from "../../src/components/logo-creation/concept-refinements";
import { syntheticRasterRefinement } from "../fixtures/logo-refinement-history";
import type { LogoRefinementHistoryState } from "../../src/components/logo-creation/refinement-history";

const record = syntheticRasterRefinement();
const history = (verified = true): LogoRefinementHistoryState => ({ items: [{ record, verified, error: null }], nextCursor: null, loaded: true, loading: false, error: null });
const render = (state: LogoRefinementHistoryState) => renderToStaticMarkup(createElement(ConceptRefinements, { history: state, selected: { kind: "refinement", rasterRevisionId: record.id }, onSelect: () => {}, renderPreview: receipt => createElement("span", null, receipt.reference.contentHash) }));
describe("refinement results on the concepts screen", () => {
  it("shows only a verified committed preview as a selectable saved result", () => {
    const html = render(history());
    expect(html).toContain(record.preview!.reference.contentHash);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Your refinements");
    expect(html).not.toContain("disabled");
  });
  it("never renders or selects an unverified preview", () => {
    const html = render(history(false));
    expect(html).not.toContain(record.preview!.reference.contentHash);
    expect(html).toContain("disabled");
  });
  it("does not treat uncertain billing as a completed refinement", () => {
    const state = history();
    state.items[0] = { record: syntheticRasterRefinement({ state: "needs_reconciliation", reason: "billing_unknown", billing: { status: "unknown", confirmedMicrousd: null } }), verified: true, error: null };
    const html = render(state);
    expect(html).toContain("disabled");
    expect(html).not.toContain(record.preview!.reference.contentHash);
  });
});
