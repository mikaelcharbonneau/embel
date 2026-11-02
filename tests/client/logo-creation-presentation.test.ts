import { Children, createElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LogoCreationFixturePreview } from "../fixtures/logo-creation-preview";
import { LogoBriefFields } from "../../src/components/logo-creation/brief-form";
import { LogoReferenceLimitNotice, LogoReferencePickerView } from "../../src/components/logo-creation/reference-picker";
import { LogoConceptGridView } from "../../src/components/logo-creation/concept-grid";
import { LogoCostConfirmationView } from "../../src/components/logo-creation/cost-confirmation";
import type { LogoBriefDraft, LogoReferenceSelection } from "../../src/domain/logo-workspace";
import { LOGO_TEST_FIXTURE_LABEL, syntheticLogoBrief, syntheticLogoBatch, syntheticLogoReferences, syntheticLogoQuote } from "../fixtures/logo-creation";

// The structural contract walker is not a React renderer. Exercise the sheet's
// hooks in context-details.test.tsx and keep this walker focused on picker inputs.
vi.mock("@/components/ui/context-details", () => ({ ContextDetails: ({ title, children }: { title: ReactNode; children: ReactNode }) => createElement("section", null, title, children) }));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    if (typeof child.type === "function") return elements((child.type as (props: Record<string, unknown>) => ReactNode)(child.props));
    return [child, ...elements(child.props.children as ReactNode)];
  });
}
function control(node: ReactNode, name: string) {
  const result = elements(node).find(element => element.props["aria-label"] === name);
  if (!result) throw new Error(`Missing accessible control: ${name}`);
  return result;
}
function change(element: Element, value: string | boolean) {
  (element.props.onChange as (event: unknown) => void)({ currentTarget: typeof value === "string" ? { value } : { checked: value } });
}
function click(element: Element) { (element.props.onClick as () => void)(); }
function fixtureMarkup(node: ReactNode) {
  return renderToStaticMarkup(createElement("section", { "aria-label": "Test fixture" }, createElement("p", null, LOGO_TEST_FIXTURE_LABEL), node));
}

describe("logo presentation (test-only domain bindings)", () => {
  it("warns before generating unsupported name characters while preserving editing and saving", () => {
    const onChange = vi.fn(), onSave = vi.fn();
    const node = LogoBriefFields({ draft: { ...syntheticLogoBrief(), name: "Cedar 🦊" }, onChange, onSave, autoSave: true });
    expect(renderToStaticMarkup(node)).toContain("Some characters in this name cannot yet be rendered");
    expect(control(node, "Brand name").props.disabled).toBe(false);
    expect(control(node, "Save brief").props.disabled).toBe(false);
    change(control(node, "Brand name"), "さくら"); expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: "さくら" }));
    click(control(node, "Save brief")); expect(onSave).toHaveBeenCalledOnce();
  });
  it.each(["", "さくら", "العربية", "देव Studio"])("does not warn about supported or unentered brand names: %s", name => {
    const node = LogoBriefFields({ draft: { ...syntheticLogoBrief(), name }, onChange: () => undefined });
    expect(renderToStaticMarkup(node)).not.toContain("cannot yet be rendered");
    expect(renderToStaticMarkup(node)).not.toContain("Enter a brand name before generating");
  });
  it("shows the operation-specific image limits and retains an over-limit reference count", () => {
    const overLimit = renderToStaticMarkup(createElement(LogoReferenceLimitNotice, { count: 5 }));
    expect(overLimit).toContain("5 selected reference images"); expect(overLimit).toContain("Concepts allow up to 4");
    expect(overLimit).toContain("up to 3 references plus its original logo image"); expect(overLimit).toContain("Deselect extra references");
    expect(overLimit).toContain("earlier versions are kept");
    expect(renderToStaticMarkup(createElement(LogoReferenceLimitNotice, { count: 4 }))).toContain("Choose at most 3 if you plan to refine it later");
  });
  it.each([{ request: null }, { request: { status: "not_found" as const } }])("keeps original-request recovery available before a batch receipt: $request", ({ request }) => {
    const reads: string[] = [];
    const newRequests: string[] = [];
    const originalKey = "retained-original-request";
    const node = LogoConceptGridView({ batch: null, request, generation: { status: "available" },
      onCheckRequest: () => reads.push(originalKey), onRequestConcepts: () => newRequests.push("concepts") });
    expect(control(node, "Check request").props.disabled).toBe(false);
    expect(fixtureMarkup(node)).toContain("Outcome uncertain");
    expect(reads).toEqual([]);
    click(control(node, "Check request"));
    expect(reads).toEqual([originalKey]);
    expect(newRequests).toEqual([]);
    expect(control(LogoConceptGridView({ batch: null, request }), "Check request").props.disabled).toBe(true);
  });
  it("shows the recorded charge on a failed attempt without contradicting it in cost review", () => {
    const batch = syntheticLogoBatch();
    const node = LogoConceptGridView({ batch });
    const failedCard = elements(node).find(element => element.props["data-concept-ordinal"] === 5)!;
    const html = renderToStaticMarkup(failedCard);
    expect(html).toContain("Failed");
    expect(html).toContain("Attempt 1");
    expect(html).toContain("Confirmed charge: $0.10");
    const composition = renderToStaticMarkup(createElement(LogoCreationFixturePreview, { scenario: "partial" }));
    expect(composition).not.toContain("No confirmed charge is available");
  });
  it("never offers a successful retained preview in a failed-only retry", () => {
    const original = syntheticLogoBatch(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
    const slot = original.slots[0]!, previous = slot.attempts[0]!;
    const batch = { ...original, slots: original.slots.map(item => item.id === slot.id ? { ...item, attempts: [previous, { ...previous, id: "00000000-0000-4000-8000-000000000999", previousAttemptId: previous.id, attemptNumber: 2, state: "failed" as const, preview: null }] } : item) };
    const node = LogoConceptGridView({ batch, generation: { status: "available" }, onRequestRetryFailed: () => undefined });
    expect(fixtureMarkup(node)).toContain("6 of 6 concepts ready");
    expect(elements(node).some(element => String(element.props["aria-label"]).startsWith("Retry "))).toBe(false);
  });
  it("explains a recovered delivery failure and retries only that slot after a deliberate click", () => {
    const batch = structuredClone(syntheticLogoBatch(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "failed"]));
    batch.slots[5]!.attempts[0]!.reason = "logo_image_unavailable";
    const retry = vi.fn();
    const node = LogoConceptGridView({ batch, gallery: true, generation: { status: "available" }, onRequestRetryFailed: retry });
    const html = fixtureMarkup(node);
    expect(html).toContain("5 of 6 concepts ready");
    expect(html).toContain("This image could not be saved.");
    expect(html).toContain("AI usage for this attempt is still recorded.");
    expect(html).not.toContain("Outcome uncertain");
    expect(retry).not.toHaveBeenCalled();
    const action = control(node, "Retry 1 failed concept");
    expect(action.props.disabled).toBe(false);
    click(action);
    expect(retry).toHaveBeenCalledWith([batch.slots[5]!.id]);
  });
  it("retains a previous recorded attempt charge while a later attempt has unknown billing", () => {
    const original = syntheticLogoBatch();
    const slot = original.slots[5]!;
    const previous = slot.attempts[0]!;
    const retry = { ...previous, id: "00000000-0000-4000-8000-000000000999", attemptNumber: 2, previousAttemptId: previous.id,
      state: "needs_reconciliation" as const, reason: "outcome_unknown", billing: { status: "unknown" as const, confirmedMicrousd: null } };
    const batch = { ...original, slots: original.slots.map(item => item.id === slot.id ? { ...item, attempts: [previous, retry] } : item) };
    const node = LogoConceptGridView({ batch });
    const card = elements(node).find(element => element.props["data-concept-ordinal"] === 5)!;
    const html = renderToStaticMarkup(card);
    expect(html).toContain("Attempt 1");
    expect(html).toContain("Confirmed charge: $0.10");
    expect(html).toContain("Attempt 2");
    expect(html).toContain("Charge not confirmed");
    expect(html).not.toContain("$0.20");
    expect(html).not.toContain("Total");
    expect(fixtureMarkup(LogoCostConfirmationView({ billing: { status: "unknown", confirmedMicrousd: null } }))).toContain("Charge not confirmed for this request");
  });
  it("clears a concept-one refinement estimate when the actual fixture selection changes to concept two", () => {
    // Real React state and the fixture's actual callbacks; render-phase updates avoid a browser/runtime.
    function SelectionTransition() {
      const [step, setStep] = useState(0);
      const node = LogoCreationFixturePreview({ scenario: "partial" });
      if (step === 0) { click(control(node, "Select concept 1")); setStep(1); }
      if (step === 1) { click(control(node, "Refine selected")); setStep(2); }
      if (step === 2) { click(control(node, "Select concept 2")); setStep(3); }
      return node;
    }
    const html = renderToStaticMarkup(createElement(SelectionTransition));
    expect(html).not.toContain("Estimated cost");
    expect(html).not.toContain("refine preview cost review requested");
    expect(html).toContain('aria-label="Select concept 2" aria-pressed="true"');
  });
  it("labels the quoted operation and exact batch concept target rather than the current selection", () => {
    const batch = syntheticLogoBatch();
    const fixture = syntheticLogoQuote();
    const slot = batch.slots[0]!;
    const quote = { ...fixture, conceptPlan: null, targetSlotIds: [slot.id], request: {
      operation: "refine_preview" as const, expected: fixture.expected, instruction: "Test fixture refinement", source: {
        kind: "concept" as const, batchId: batch.id, slotId: slot.id, attemptId: slot.attempts[0]!.id,
      },
    } };
    const html = fixtureMarkup(LogoCostConfirmationView({ quote, batch }));
    expect(html).toContain("Refine this concept");
    expect(html).toContain("Concept 1 · Wordmark · attempt 1");
    const retry = { ...fixture, conceptPlan: null, targetSlotIds: [batch.slots[5]!.id], request: {
      operation: "retry_failed" as const, expected: fixture.expected, sourceBatchId: batch.id, failedSlotIds: [batch.slots[5]!.id],
    } };
    expect(fixtureMarkup(LogoCostConfirmationView({ quote: retry, batch }))).toContain("Retry 1 failed concept");
    expect(fixtureMarkup(LogoCostConfirmationView({ quote: retry, batch }))).toContain("Concept 6");
    expect(fixtureMarkup(LogoCostConfirmationView({ quote: fixture }))).toContain("Generate 6 concepts");
    const more = { ...fixture, request: { operation: "more_concepts" as const, expected: fixture.expected, briefRevisionId: batch.briefRevisionId, referenceSnapshotId: batch.referenceSnapshotId } };
    expect(fixtureMarkup(LogoCostConfirmationView({ quote: more }))).toContain("Generate 6 more concepts");
  });
  it("composes the controls only under an explicit test fixture label", () => {
    const html = renderToStaticMarkup(createElement(LogoCreationFixturePreview, { scenario: "partial" }));
    expect(html).toContain(LOGO_TEST_FIXTURE_LABEL);
    expect(html).toContain("5 of 6 concepts ready");
    expect(html).toContain("Brand name");
    expect(html).toContain("Confirm generation");
  });
  it("keeps blank defaults honest and exposes four fields and all seven selectable types", () => {
    const node = LogoBriefFields({});
    expect(elements(node).filter(element => element.type === "input" && element.props.type === "checkbox")).toHaveLength(7);
    for (const name of ["Brand name", "What the business does", "Audience", "Desired personality"]) expect(control(node, name).props.value).toBe("");
    expect(control(node, "Save brief").props.disabled).toBe(true);
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Saving is unavailable");
    expect(html).not.toContain("Élan");
  });
  it("edits the exact four fields and all seven types without implicitly reusing or saving", () => {
    let draft = syntheticLogoBrief({ logoTypes: [] });
    let reuseCalls = 0;
    const props = () => ({ draft, onChange: (next: LogoBriefDraft) => { draft = next; }, onReuseStrategy: () => { reuseCalls++; } });
    const node = LogoBriefFields(props());
    expect(reuseCalls).toBe(0);
    for (const [label, value] of [["Brand name", "E\u0301lan & Co"], ["What the business does", "Tea"], ["Audience", "Readers"], ["Desired personality", "Quiet"]]) change(control(LogoBriefFields(props()), label!), value!);
    for (const label of ["Wordmark", "Lettermark or monogram", "Pictorial mark", "Abstract mark", "Combination mark", "Emblem", "Mascot"]) change(control(LogoBriefFields(props()), label), true);
    expect(draft).toEqual({ name: "E\u0301lan & Co", activity: "Tea", audience: "Readers", personality: "Quiet", logoTypes: ["wordmark", "lettermark_monogram", "pictorial", "abstract", "combination", "emblem", "mascot"] });
    click(control(node, "Reuse Strategy"));
    expect(reuseCalls).toBe(1);
  });
  it("shows the name conflict and source revision while leaving the exact name editable", () => {
    const node = LogoBriefFields({ draft: syntheticLogoBrief(), onChange: () => {}, nameConflict: true, sourceProjectRevision: 4 });
    expect(control(node, "Brand name").props["aria-invalid"]).toBe(false);
    expect(fixtureMarkup(node)).toContain("Strategy revision 4");
    expect(fixtureMarkup(node)).toContain("The selected name is copied below; review its exact spelling before generating");
  });
  it("offers the same four independent aspects for curated and uploaded references", () => {
    const references = syntheticLogoReferences();
    let selections: LogoReferenceSelection[] = [];
    const render = () => LogoReferencePickerView({ references, selections, onChange: next => { selections = next; } });
    for (const reference of references) {
      for (const aspect of ["Lettering", "Shape", "Composition", "Overall feel"]) change(control(render(), `${aspect} for ${reference.sourceKind === "curated" ? "curated" : "uploaded"} reference 1`), true);
    }
    expect(selections.map(selection => selection.aspects)).toEqual([["lettering", "shape", "composition", "overall_feel"], ["lettering", "shape", "composition", "overall_feel"]]);
    for (const aspect of ["Lettering", "Shape", "Composition", "Overall feel"]) change(control(render(), `${aspect} for curated reference 1`), false);
    expect(selections).toEqual([{ referenceId: references[1]!.referenceId, aspects: ["lettering", "shape", "composition", "overall_feel"] }]);
  });
  it("does not turn a rights declaration into an upload or licensed catalog", () => {
    const node = LogoReferencePickerView({});
    expect(control(node, "Choose a reference image").props.disabled).toBe(true);
    expect(control(node, "Browse reference library").props.disabled).toBe(true);
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Reference library unavailable");
    expect(html).toContain("Uploads are unavailable");
    expect(html).toContain("permission");
  });
  it("keeps six stable positions, retains five results and retries only the confirmed failed slot", () => {
    const original = syntheticLogoBatch();
    const batch = { ...original, slots: [...original.slots].reverse() };
    const requested: string[][] = [];
    const node = LogoConceptGridView({ batch, generation: { status: "available" }, onRequestRetryFailed: ids => requested.push(ids) });
    expect(elements(node).filter(element => element.props["data-concept-ordinal"] !== undefined).map(element => element.props["data-concept-ordinal"])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fixtureMarkup(node)).toContain("5 of 6 concepts ready");
    expect(fixtureMarkup(node)).toContain("Image preview");
    expect(fixtureMarkup(node)).toContain("Not included in this batch: Mascot");
    click(control(node, "Retry 1 failed concept"));
    expect(requested).toEqual([[batch.slots[0]!.id]]);
    expect(batch.slots.filter(slot => slot.acceptedPreview)).toHaveLength(5);
  });
  it("shows committed successful attempts when the live convenience projection is null", () => {
    const original = syntheticLogoBatch();
    const batch = { ...original, slots: original.slots.map(slot => ({ ...slot, acceptedPreview: null })) };
    const node = LogoConceptGridView({ batch, renderPreview: receipt => createElement("span", null, receipt.id) });
    const html = fixtureMarkup(node);
    expect(html).toContain("5 of 6 concepts ready");
    expect(html).toContain(original.slots[0]!.attempts[0]!.preview!.id);
    expect(html).not.toContain("Image preview unavailable");
  });
  it("offers Check request for an uncertain result without offering a retry", () => {
    const batch = syntheticLogoBatch(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "needs_reconciliation"]);
    let checks = 0;
    const node = LogoConceptGridView({ batch, onCheckRequest: () => { checks++; } });
    expect(fixtureMarkup(node)).toContain("Outcome uncertain");
    expect(fixtureMarkup(node)).not.toContain("Retry 1 failed concept");
    click(control(node, "Check request"));
    expect(checks).toBe(1);
    expect(batch.slots[5]!.attempts).toHaveLength(1);
  });
  it("keeps More, Refine and Check as distinct explicit requests tied to the selected committed attempt", () => {
    const batch = syntheticLogoBatch();
    const selected = { kind: "concept" as const, batchId: batch.id, slotId: batch.slots[0]!.id, attemptId: batch.slots[0]!.attempts[0]!.id };
    const actions: unknown[] = [];
    const node = LogoConceptGridView({ batch, selected, generation: { status: "available" },
      onRequestMore: () => actions.push("more"), onRequestRefine: source => actions.push(source), onCheckRequest: () => actions.push("check") });
    expect(actions).toEqual([]);
    click(control(node, "More concepts"));
    click(control(node, "Refine selected"));
    click(control(node, "Check request"));
    expect(actions).toEqual(["more", selected, "check"]);
    const unavailable = LogoConceptGridView({ batch, selected, onRequestMore: () => {}, onRequestRefine: () => {} });
    expect(control(unavailable, "More concepts").props.disabled).toBe(true);
    expect(control(unavailable, "Refine selected").props.disabled).toBe(true);
  });
  it("retains committed result metadata when its preview cannot be displayed", () => {
    const batch = syntheticLogoBatch();
    const node = LogoConceptGridView({ batch });
    expect(fixtureMarkup(node)).toContain("5 of 6 concepts ready");
    expect(fixtureMarkup(node)).toContain("Image preview unavailable");
    expect(elements(node).filter(element => element.type === "img")).toHaveLength(0);
  });
  it("shows supplied estimates separately from recorded charges and never admits without the controller", () => {
    const node = LogoCostConfirmationView({ quote: syntheticLogoQuote(), billing: { status: "recorded", confirmedMicrousd: 900000 } });
    const html = fixtureMarkup(node);
    expect(html).toContain("Estimated cost");
    expect(html).toContain("$0.60");
    expect(html).toContain("$1.20");
    expect(html).toContain("Confirmed charge");
    expect(html).toContain("$0.90");
    expect(control(node, "Confirm generation").props.disabled).toBe(true);
    expect(renderToStaticMarkup(LogoCostConfirmationView({}))).not.toContain("$0");
  });
  it("shows confirmation progress without reporting generation unavailable", () => {
    const html = fixtureMarkup(LogoCostConfirmationView({ quote: syntheticLogoQuote(), busy: true }));
    expect(html).toContain("Confirming request…");
    expect(html).not.toContain("Generation is unavailable");
  });
});


it("keeps refinement and concept capabilities independent in the mounted view contract", () => {
  const batch = syntheticLogoBatch(), slot = batch.slots[0]!, selected = { kind: "concept" as const, batchId: batch.id, slotId: slot.id, attemptId: slot.attempts[0]!.id };
  const node = LogoConceptGridView({ batch, selected, generation: { status: "unavailable", reason: "Concepts unavailable" }, refinement: { status: "available" }, onRequestRefine: () => undefined, onRequestMore: () => undefined });
  expect(control(node, "Refine selected").props.disabled).toBe(false); expect(control(node, "More concepts").props.disabled).toBe(true);
});
