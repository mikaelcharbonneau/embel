import type { StandalonePayloadCodec } from "@/domain/standalone-workspaces";
import { createTrademarkDraft, trademarkDraftSchema, trademarkReviewKey, type TrademarkDraft } from "./domain";

export const TRADEMARK_DRAFT_MAX_BYTES = 120_000;
/** The review marker records the user's acknowledgement of the exact draft only. */
export const trademarkAccountDraftSchema = trademarkDraftSchema.superRefine((draft, context) => {
  if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > TRADEMARK_DRAFT_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "This trademark draft is too large to save." });
  }
  if (draft.reviewedContent !== null && draft.reviewedContent !== trademarkReviewKey(draft)) {
    context.addIssue({ code: "custom", path: ["reviewedContent"], message: "Review applies only to the exact draft content." });
  }
});
export function parseTrademarkAccountDraft(input: unknown): TrademarkDraft { return trademarkAccountDraftSchema.parse(input); }
export const createEmptyTrademarkAccountDraft = createTrademarkDraft;
export const standalonePayloadCodec = { tool: "trademarks", schema: trademarkAccountDraftSchema } satisfies StandalonePayloadCodec<TrademarkDraft>;
