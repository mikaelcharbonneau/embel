import { describe, expect, it } from "vitest";
import { assessTrademarkDossier, buildTrademarkDraftPreview, confirmTrademarkReview, createTrademarkDraft, serializeTrademarkDraftPreview, trademarkBrandSeed, validateTrademarkDraft, type TrademarkDraft } from "../../../src/features/trademark-workspace/domain";

function filled(): TrademarkDraft {
  return { ...createTrademarkDraft("Fixture Mark"), markType: "word", territories: ["Requested fixture territory"], owner: { name: "Fixture owner", address: "Fixture address", contact: "Fixture contact" }, goodsServices: "Fixture goods description", classificationNotes: "Classification to confirm", documents: { plan: "none-planned", notes: "" } };
}

describe("trademark draft preparation (no registry/provider)", () => {
  it("accepts an empty bounded draft and reports all missing sections", () => {
    const draft = createTrademarkDraft();
    expect(validateTrademarkDraft(draft).success).toBe(true);
    expect(assessTrademarkDossier(draft)).toMatchObject({ completed: 0, total: 6, stage: "draft", intakeComplete: false, reviewCurrent: false });
  });
  it("treats whitespace-only details as missing", () => {
    expect(assessTrademarkDossier({ ...filled(), goodsServices: " \n " }).sections.find((s) => s.id === "goods")?.complete).toBe(false);
  });
  it.each([["Fixture territory", " fixture TERRITORY "], [""], ["   "]])("rejects incomplete/duplicate territory intake %j", (...territories) => {
    expect(assessTrademarkDossier({ ...filled(), territories }).sections.find((s) => s.id === "territories")?.complete).toBe(false);
  });
  it("does not claim territory support for a user-requested territory", () => {
    const preview = buildTrademarkDraftPreview(filled());
    expect(preview.dependencies.every((item) => item.status === "unavailable")).toBe(true);
    expect(preview.research).toEqual({ status: "unavailable", matches: [] });
  });
  it("requires representation notes for a logo or combined mark", () => {
    for (const markType of ["logo", "combined"] as const) {
      expect(assessTrademarkDossier({ ...filled(), markType }).intakeComplete).toBe(false);
      expect(assessTrademarkDossier({ ...filled(), markType, representationNotes: "Planned logo reference" }).intakeComplete).toBe(true);
    }
  });
  it("requires document notes when documents are planned", () => {
    expect(assessTrademarkDossier({ ...filled(), documents: { plan: "listed", notes: "" } }).intakeComplete).toBe(false);
    expect(assessTrademarkDossier({ ...filled(), documents: { plan: "listed", notes: "Planned file, not uploaded" } }).intakeComplete).toBe(true);
  });
  it("reports only intake completion, never readiness to file", () => {
    expect(assessTrademarkDossier(filled()).stage).toBe("intake-complete");
    expect(assessTrademarkDossier(confirmTrademarkReview(filled())).stage).toBe("reviewed-draft");
    expect(assessTrademarkDossier(confirmTrademarkReview(createTrademarkDraft())).stage).toBe("draft");
  });
  it("invalidates review on any changed dossier section or notes", () => {
    const reviewed = confirmTrademarkReview(filled());
    const variants: TrademarkDraft[] = [
      { ...reviewed, markName: "Changed" }, { ...reviewed, markType: "logo" }, { ...reviewed, representationNotes: "Changed" },
      { ...reviewed, territories: ["Changed"] }, { ...reviewed, owner: { ...reviewed.owner, address: "Changed" } },
      { ...reviewed, goodsServices: "Changed" }, { ...reviewed, classificationNotes: "Changed" },
      { ...reviewed, documents: { plan: "listed", notes: "Changed" } }, { ...reviewed, userNotes: "Changed" },
    ];
    expect(variants.every((draft) => !assessTrademarkDossier(draft).reviewCurrent)).toBe(true);
  });
  it("can review a maximum-length draft with escaped characters", () => {
    const draft = { ...filled(), representationNotes: '"'.repeat(2000), goodsServices: '\n'.repeat(6000), classificationNotes: '"'.repeat(2000), userNotes: '\t'.repeat(4000), documents: { plan: "listed" as const, notes: '\n'.repeat(4000) } };
    expect(validateTrademarkDraft(confirmTrademarkReview(draft)).success).toBe(true);
  });
  it("exports incomplete drafts with missing-section and dependency information", () => {
    const preview = buildTrademarkDraftPreview({ ...createTrademarkDraft("Fixture"), userNotes: "User says available" });
    const exported = JSON.parse(serializeTrademarkDraftPreview(preview));
    expect(exported.label).toBe("Draft preview — not a filing dossier");
    expect(exported.inputOrigin).toBe("user-entered");
    expect(exported.draft.userNotes).toBe("User says available");
    expect(exported.research.matches).toEqual([]);
    expect(exported.completeness.intakeComplete).toBe(false);
    expect(exported.limitations).toContain("No application has been submitted or registered. Official filing requirements remain unvalidated.");
  });
  it("rejects unbounded, malformed or evidence-bearing draft input", () => {
    for (const draft of [null, { ...filled(), status: "registered" }, { ...filled(), research: { matches: ["Fake result"] } }, { ...filled(), markName: "x".repeat(161) }, { ...filled(), territories: Array(21).fill("Fixture") }, { ...filled(), territories: ["x".repeat(161)] }, { ...filled(), userNotes: "bad\u0000text" }, { ...filled(), owner: { ...filled().owner, ownerId: "fake" } }]) {
      expect(validateTrademarkDraft(draft).success).toBe(false);
    }
  });
  it("creates a limited brand seed without owner personal data or strategy approvals", () => {
    expect(trademarkBrandSeed(filled())).toEqual({ origin: "trademark-draft", name: "Fixture Mark", description: "Fixture goods description", notes: "", trademarkResearch: "unavailable" });
    expect(() => trademarkBrandSeed(createTrademarkDraft())).toThrow("Add a mark name");
  });
});
