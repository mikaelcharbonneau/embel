import { z } from "zod";

const text = (max: number) => z.string().max(max).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), "Remove control characters.");
export const trademarkDraftSchema = z.strictObject({
  version: z.literal(1),
  markName: text(160),
  markType: z.enum(["", "word", "logo", "combined"]),
  representationNotes: text(2000),
  territories: z.array(text(160)).max(20),
  owner: z.strictObject({ name: text(300), address: text(2000), contact: text(300) }),
  goodsServices: text(6000),
  classificationNotes: text(2000),
  documents: z.strictObject({ plan: z.enum(["unknown", "none-planned", "listed"]), notes: text(4000) }),
  userNotes: text(4000),
  reviewedContent: z.string().max(60000).nullable(),
});
export type TrademarkDraft = z.infer<typeof trademarkDraftSchema>;

export function createTrademarkDraft(markName = ""): TrademarkDraft {
  return { version: 1, markName, markType: "", representationNotes: "", territories: [], owner: { name: "", address: "", contact: "" }, goodsServices: "", classificationNotes: "", documents: { plan: "unknown", notes: "" }, userNotes: "", reviewedContent: null };
}

// Product intake limits, not a legal or territory-specific filing schema.
export function validateTrademarkDraft(input: unknown) {
  return trademarkDraftSchema.safeParse(input);
}

export function trademarkReviewKey(draft: TrademarkDraft): string {
  const content = { ...trademarkDraftSchema.parse(draft) };
  delete (content as Partial<TrademarkDraft>).reviewedContent;
  return JSON.stringify(content);
}

export function confirmTrademarkReview(draft: TrademarkDraft): TrademarkDraft {
  return { ...draft, reviewedContent: trademarkReviewKey(draft) };
}

export type DossierSection = { id: "mark" | "territories" | "owner" | "goods" | "classification" | "documents"; label: string; complete: boolean; guidance: string };
export type DossierCompleteness = { sections: DossierSection[]; completed: number; total: number; intakeComplete: boolean; reviewCurrent: boolean; stage: "draft" | "intake-complete" | "reviewed-draft" };

export function assessTrademarkDossier(input: TrademarkDraft): DossierCompleteness {
  const draft = trademarkDraftSchema.parse(input);
  const territories = draft.territories.map((territory) => territory.trim().toLocaleLowerCase("en-US"));
  const sections: DossierSection[] = [
    { id: "mark", label: "Mark representation", complete: Boolean(draft.markName.trim() && draft.markType && (draft.markType === "word" || draft.representationNotes.trim())), guidance: "Add a name and mark type. For a logo or combined mark, describe the representation you plan to provide." },
    { id: "territories", label: "Requested territories", complete: Boolean(territories.length && territories.every(Boolean) && new Set(territories).size === territories.length), guidance: "Add distinct requested territories. Coverage and territorial requirements remain unvalidated." },
    { id: "owner", label: "Proposed owner", complete: Boolean(draft.owner.name.trim() && draft.owner.address.trim() && draft.owner.contact.trim()), guidance: "Add the proposed owner's name, address and contact details." },
    { id: "goods", label: "Goods and services", complete: Boolean(draft.goodsServices.trim()), guidance: "Describe the goods or services in your own words." },
    { id: "classification", label: "Classification notes", complete: Boolean(draft.classificationNotes.trim()), guidance: "Record your proposed classification or questions. No class assignment is verified." },
    { id: "documents", label: "Supporting document plan", complete: draft.documents.plan === "none-planned" || (draft.documents.plan === "listed" && Boolean(draft.documents.notes.trim())), guidance: "List planned documents or record that none are planned. Required documents remain unvalidated." },
  ];
  const completed = sections.filter((section) => section.complete).length;
  const intakeComplete = completed === sections.length;
  const reviewCurrent = draft.reviewedContent === trademarkReviewKey(draft);
  return { sections, completed, total: sections.length, intakeComplete, reviewCurrent, stage: intakeComplete ? (reviewCurrent ? "reviewed-draft" : "intake-complete") : "draft" };
}

export const trademarkDependencies = [
  { id: "territory-support", status: "unavailable", label: "Territory support", detail: "No supported territory has been validated. Requested territories are user input." },
  { id: "registry-data", status: "unavailable", label: "Registry research", detail: "No registry adapter or data access is connected. No search has run." },
  { id: "filing-rules", status: "unavailable", label: "Territorial dossier rules", detail: "Required fields, documents, official portal links and export formats have not been validated." },
] as const;

export type TrademarkDraftPreview = {
  kind: "trademark-draft-preview";
  version: 1;
  label: "Draft preview — not a filing dossier";
  inputOrigin: "user-entered";
  draft: TrademarkDraft;
  completeness: DossierCompleteness;
  research: { status: "unavailable"; matches: readonly never[] };
  dependencies: typeof trademarkDependencies;
  limitations: readonly string[];
};

export function buildTrademarkDraftPreview(input: TrademarkDraft): TrademarkDraftPreview {
  const draft = trademarkDraftSchema.parse(input);
  return {
    kind: "trademark-draft-preview", version: 1, label: "Draft preview — not a filing dossier", inputOrigin: "user-entered",
    draft, completeness: assessTrademarkDossier(draft), research: { status: "unavailable", matches: [] }, dependencies: trademarkDependencies,
    limitations: ["All entries are user-entered notes, not sourced registry results.", "Intake completeness does not establish legal clearance, registrability or readiness to file.", "No application has been submitted or registered. Official filing requirements remain unvalidated."],
  };
}

export function serializeTrademarkDraftPreview(preview: TrademarkDraftPreview): string {
  // Rebuild from the bounded input so callers cannot inject a research/filing claim.
  return JSON.stringify(buildTrademarkDraftPreview(preview.draft), null, 2);
}

export type TrademarkBrandSeed = { origin: "trademark-draft"; name: string; description: string; notes: string; trademarkResearch: "unavailable" };
export function trademarkBrandSeed(input: TrademarkDraft): TrademarkBrandSeed {
  const draft = trademarkDraftSchema.parse(input);
  if (!draft.markName.trim()) throw new Error("Add a mark name before creating a brand.");
  return { origin: "trademark-draft", name: draft.markName.trim(), description: draft.goodsServices.trim(), notes: draft.userNotes.trim(), trademarkResearch: "unavailable" };
}
