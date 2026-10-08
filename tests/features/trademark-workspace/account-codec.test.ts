import { describe, expect, it } from "vitest";
import { createEmptyTrademarkAccountDraft, parseTrademarkAccountDraft, standalonePayloadCodec, trademarkAccountDraftSchema } from "@/features/trademark-workspace/account-codec";
import { assessTrademarkDossier, buildTrademarkDraftPreview, confirmTrademarkReview, createTrademarkDraft, type TrademarkDraft } from "@/features/trademark-workspace/domain";

function draft(): TrademarkDraft {
  return { ...createTrademarkDraft("Fixture"), markType: "word", territories: ["Requested territory"], owner: { name: "Proposed owner", address: "Address", contact: "Contact" }, goodsServices: "Proposed services", classificationNotes: "To check", documents: { plan: "none-planned", notes: "" } };
}

describe("strict persisted Trademark user draft codec", () => {
  it("round-trips the complete user draft with an informational exact review marker", () => {
    const input = confirmTrademarkReview(draft()), parsed = parseTrademarkAccountDraft(JSON.parse(JSON.stringify(input)));
    expect(parsed).toEqual(input);
    expect(assessTrademarkDossier(parsed).stage).toBe("reviewed-draft");
    expect(buildTrademarkDraftPreview(parsed).research).toEqual({ status: "unavailable", matches: [] });
    expect(standalonePayloadCodec.tool).toBe("trademarks");
    expect(parseTrademarkAccountDraft(createEmptyTrademarkAccountDraft())).toEqual(createTrademarkDraft());
  });

  it("accepts JSON object key reordering without changing the review binding", () => {
    const input = confirmTrademarkReview(draft());
    expect(parseTrademarkAccountDraft(Object.fromEntries(Object.entries(input).reverse()))).toEqual(input);
  });

  it("rejects a stale or forged marker and keeps the caller's draft untouched", () => {
    const reviewed = confirmTrademarkReview(draft());
    for (const input of [{ ...reviewed, markName: "Other" }, { ...reviewed, userNotes: "More notes" }, { ...reviewed, reviewedContent: "cleared" }]) {
      expect(trademarkAccountDraftSchema.safeParse(input).success).toBe(false);
    }
    expect(assessTrademarkDossier(reviewed).reviewCurrent).toBe(true);
    expect(parseTrademarkAccountDraft({ ...reviewed, markName: "Other", reviewedContent: null }).markName).toBe("Other");
  });

  it("rejects extra ownership, research, clearance and filed status assertions", () => {
    const input = draft();
    for (const extra of [{ ownerId: "foreign" }, { status: "filed" }, { registered: true }, { clearance: "clear" }, { research: { matches: [] } }, { filing: { submittedAt: "2026-01-01" } }, { providerAvailability: "ready" }]) {
      expect(trademarkAccountDraftSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    expect(trademarkAccountDraftSchema.safeParse({ ...input, owner: { ...input.owner, verified: true } }).success).toBe(false);
    expect(trademarkAccountDraftSchema.safeParse({ ...input, documents: { ...input.documents, attached: true } }).success).toBe(false);
  });

  it("rejects invalid shape, control characters and bounds", () => {
    for (const input of [null, { ...draft(), version: 2 }, { ...draft(), userNotes: "x\u0000y" }, { ...draft(), markName: "a".repeat(161) }, { ...draft(), territories: Array(21).fill("Territory") }, { ...draft(), documents: { plan: "filed", notes: "" } }]) {
      expect(trademarkAccountDraftSchema.safeParse(input).success).toBe(false);
    }
  });

  it("applies a UTF-8 byte bound including the duplicated review key", () => {
    const input = { ...draft(), representationNotes: "界".repeat(2000), goodsServices: "界".repeat(6000), userNotes: "界".repeat(4000), documents: { plan: "listed" as const, notes: "界".repeat(4000) }, classificationNotes: "界".repeat(2000), owner: { name: "界".repeat(300), address: "界".repeat(2000), contact: "界".repeat(300) } };
    expect(trademarkAccountDraftSchema.safeParse(input).success).toBe(true);
    expect(trademarkAccountDraftSchema.safeParse(confirmTrademarkReview(input)).success).toBe(false);
  });
});
