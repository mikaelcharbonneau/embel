import type { VerifiedAccount } from "@/components/workspace/account-session";
import { attachIdeaToProjectInputSchema, ideaProjectAttachmentOutcomeSchema, type AttachIdeaToProjectInput, type IdeaProjectAttachmentOutcome } from "@/domain/idea-project-attachment";
import { standalonePromotionInputSchema, standalonePromotionReceiptSchema, type StandalonePromotionInput, type StandalonePromotionReceipt } from "@/domain/standalone-promotion";
import { freezeLogoRecord } from "@/domain/logo-vector";
export type LifecycleIntent =
 | { kind: "idea_attachment"; input: AttachIdeaToProjectInput; receipt: IdeaProjectAttachmentOutcome | null; outcome: "pending" | "uncertain" | "confirmed" }
 | { kind: "standalone_promotion"; input: StandalonePromotionInput; receipt: StandalonePromotionReceipt | null; outcome: "pending" | "uncertain" | "confirmed" };
export function attachmentReceiptMatches(input: AttachIdeaToProjectInput, receipt: IdeaProjectAttachmentOutcome) {
 return receipt.requestKey === input.requestKey && JSON.stringify(receipt.input) === JSON.stringify(input);
}
export function promotionReceiptMatches(input: StandalonePromotionInput, receipt: StandalonePromotionReceipt) {
 const s = receipt.source;
 return receipt.requestKey === input.requestKey && s.workspaceId === input.workspaceId && s.workspaceRevision === input.expectedWorkspaceRevision &&
  JSON.stringify(s.selection) === JSON.stringify(input.selection) && receipt.project.title === input.title && receipt.project.current_revision === 1 &&
  (input.contextSource === null ? s.contextSource === null : !!s.contextSource && s.contextSource.projectId === input.contextSource.projectId && s.contextSource.projectRevision === input.contextSource.projectRevision && s.contextSource.selectionId === input.contextSource.selectionId);
}
/** Provider-lifetime only; private intents never enter browser durable storage. */
export function createLifecycleIntentMemory() {
 let owner: string | null = null, verified: VerifiedAccount | null = null;
 const records = new Map<LifecycleIntent["kind"], LifecycleIntent>(), listeners = new Set<() => void>();
 const publish = () => listeners.forEach(listener => listener());
 const isCurrent = (account: VerifiedAccount) => verified?.userId === account.userId && verified.generation === account.generation;
 return {
  bind(account: VerifiedAccount | null) { if (account && owner !== null && account.userId !== owner) records.clear(); if (account) owner = account.userId; verified = account ? { ...account } : null; publish(); },
  isCurrent,
  get(account: VerifiedAccount, kind: LifecycleIntent["kind"]): LifecycleIntent | null { return isCurrent(account) ? records.get(kind) ?? null : null; },
  set(account: VerifiedAccount, value: LifecycleIntent) {
   if (!isCurrent(account)) return false;
   const intent: LifecycleIntent = value.kind === "idea_attachment"
    ? { ...value, input: attachIdeaToProjectInputSchema.parse(value.input), receipt: value.receipt ? ideaProjectAttachmentOutcomeSchema.parse(value.receipt) : null }
    : { ...value, input: standalonePromotionInputSchema.parse(value.input), receipt: value.receipt ? standalonePromotionReceiptSchema.parse(value.receipt) : null };
   if ((intent.outcome === "confirmed") !== (intent.receipt !== null)) return false;
   if (intent.receipt && (intent.receipt.ownerId !== account.userId.toLowerCase() || !(intent.kind === "idea_attachment" ? attachmentReceiptMatches(intent.input, intent.receipt) : promotionReceiptMatches(intent.input, intent.receipt)))) return false;
   const previous = records.get(intent.kind);
   if (previous && JSON.stringify(previous.input) !== JSON.stringify(intent.input) && previous.outcome !== "confirmed") return false;
   if (previous?.outcome === "confirmed" && JSON.stringify(previous.input) === JSON.stringify(intent.input) && JSON.stringify(previous) !== JSON.stringify(intent)) return false;
   records.set(intent.kind, freezeLogoRecord(structuredClone(intent))); publish(); return true;
  },
  hasUnsaved: () => [...records.values()].some(record => record.outcome !== "confirmed"),
  clear() { records.clear(); owner = null; verified = null; publish(); },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
 };
}
export type LifecycleIntentMemory = ReturnType<typeof createLifecycleIntentMemory>;
