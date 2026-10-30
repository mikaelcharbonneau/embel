import { initialConversation } from "@/domain/conversation";
import type { ProjectScope } from "@/domain/projects";
import type { LocalDraft } from "./local-drafts";

/** A pending account create, separate from the legacy recovery collection. */
export function projectStartDraft(input: Pick<LocalDraft, "scope" | "description" | "example"> & { ownerId: string }): LocalDraft {
  const now = new Date().toISOString();
  return { ...input, id: crypto.randomUUID(), title: "", activity: "", offering: "", knownAudience: "", suppliedName: "", namingNotes: "", identityNotes: "", segments: [], stage: "competitors", conversation: initialConversation(input.description, now), audienceReviewedAt: null, audienceConversationKey: null, createdAt: now, updatedAt: now };
}

export function projectStartHref(projectId: string, scope: ProjectScope) {
  return `/brands/account/${projectId}${scope === "naming_only" ? "/naming" : scope === "visual_identity_only" ? "/logo" : ""}`;
}
