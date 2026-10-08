import { standaloneImportSourceSchema, type StandaloneImportSource } from "@/domain/standalone-workspaces";
import { parseTrademarkAccountDraft } from "@/features/trademark-workspace/account-codec";
import type { TrademarkDraft } from "@/features/trademark-workspace/domain";

/** An explicit name copy preserves private intake and invalidates its prior review. */
export function importTrademarkName(input: StandaloneImportSource, current: TrademarkDraft): TrademarkDraft {
  const source = standaloneImportSourceSchema.parse(input);
  const draft = parseTrademarkAccountDraft(current);
  return parseTrademarkAccountDraft({ ...draft, markName: source.name, reviewedContent: null });
}
