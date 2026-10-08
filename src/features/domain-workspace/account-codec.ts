import type { StandalonePayloadCodec } from "@/domain/standalone-workspaces";
import { domainDraftSchema, type DomainDraft } from "./draft";

export const standalonePayloadCodec = { tool: "domains", schema: domainDraftSchema } satisfies StandalonePayloadCodec<DomainDraft>;

/** The shared owner-checked import read resolves the source; this only edits text. */
export function domainDraftFromSavedName(draft: DomainDraft, name: string): DomainDraft {
  return domainDraftSchema.parse({ ...domainDraftSchema.parse(draft), input: name, candidates: [] });
}
