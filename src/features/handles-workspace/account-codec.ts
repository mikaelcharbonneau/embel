import type { StandalonePayloadCodec } from "@/domain/standalone-workspaces";
import { emptyHandlesState, workspaceSchema, type HandlesState } from "./domain";

/** Account drafts contain user choices, never provider-authored check history. */
export const HANDLES_DRAFT_MAX_BYTES = 120_000;
export const handlesDraftSchema = workspaceSchema.superRefine((draft, context) => {
  if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > HANDLES_DRAFT_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "This handle draft is too large to save." });
  }
  draft.bundles.forEach((bundle, bundleIndex) => {
    const source = bundle.source;
    if (source.origin === "manual" ? source.projectId !== null || source.projectTitle !== null :
      source.origin === "project" ? !source.projectId || !source.projectTitle : Boolean(source.projectId) !== Boolean(source.projectTitle)) {
      context.addIssue({ code: "custom", path: ["bundles", bundleIndex, "source"], message: "Source labels must have consistent project details." });
    }
    bundle.entries.forEach((entry, entryIndex) => {
      if (entry.evidence.length !== 0) context.addIssue({ code: "custom", path: ["bundles", bundleIndex, "entries", entryIndex, "evidence"], message: "Provider checks cannot be written through a user draft." });
    });
  });
});

/** Parse rather than strip: a forged result is an error, not an accepted save. */
export function parseHandlesDraft(input: unknown): HandlesState { return handlesDraftSchema.parse(input); }
export const createEmptyHandlesDraft = emptyHandlesState;
export const standalonePayloadCodec = { tool: "handles", schema: handlesDraftSchema } satisfies StandalonePayloadCodec<HandlesState>;
