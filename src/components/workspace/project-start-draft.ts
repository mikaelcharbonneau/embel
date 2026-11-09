import { initialConversation } from "@/domain/conversation";
import type { AccountProject } from "@/domain/project-api";
import { projectStrategyHref } from "@/domain/project-handoff";
import { reconcileAccountWorkspace, type createAccountDraftMemory } from "./account-draft-memory";
import type { VerifiedAccount } from "./account-session";
import type { LocalDraft } from "./local-drafts";

/** A pending account create, separate from the legacy recovery collection. */
export function projectStartDraft(input: Pick<LocalDraft, "scope" | "description" | "example"> & { ownerId: string }): LocalDraft {
  const now = new Date().toISOString();
  return { ...input, id: crypto.randomUUID(), title: "", activity: "", offering: "", knownAudience: "", suppliedName: "", namingNotes: "", identityNotes: "", segments: [], stage: "competitors", conversation: initialConversation(input.description, now), audienceReviewedAt: null, audienceConversationKey: null, createdAt: now, updatedAt: now };
}

export function projectStartHref(projectId: string) {
  return `/brands/account/${projectId}`;
}

/** Seed only an acknowledged new Brand. A recovered project may already be at a later step. */
export function prepareProjectStart(projectId: string, created: AccountProject | null,
  account: VerifiedAccount, drafts: ReturnType<typeof createAccountDraftMemory>) {
  if (!created || created.id !== projectId || created.owner_id !== account.userId) return projectStartHref(projectId);
  drafts.set(reconcileAccountWorkspace(drafts.get(projectId), created, account.generation));
  return projectStrategyHref(projectId);
}
