import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { AccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import type { LifecycleIntent, LifecycleIntentMemory } from "./intent-memory";
/** Called only by an explicit action. Recovery reads first and reuses the exact body/key. */
export async function executeLifecycleIntent(args: { account: VerifiedAccount; memory: LifecycleIntentMemory; client: AccountLifecycleClient; intent: LifecycleIntent; signal: AbortSignal; recover: boolean }): Promise<LifecycleIntent | null> {
 const { account, memory, client, signal } = args; let intent = args.intent;
 if (!memory.isCurrent(account) || signal.aborted) return null;
 if (intent.outcome === "confirmed") return intent;
 if (!memory.set(account, { ...intent, outcome: "pending" })) return null;
 try {
  if (args.recover) {
   if (intent.kind === "idea_attachment") {
    const lookup = await client.readIdeaProjectAttachmentRequest(intent.input.requestKey, signal);
    if (!lookup || signal.aborted || !memory.isCurrent(account)) return null;
    if (lookup.status === "pending") { memory.set(account, { ...intent, outcome: "uncertain" }); return null; }
    if (lookup.status === "committed") intent = { ...intent, receipt: lookup.receipt, outcome: "confirmed" };
   } else {
    const lookup = await client.readStandalonePromotionRequest(intent.input.requestKey, signal);
    if (!lookup || signal.aborted || !memory.isCurrent(account)) return null;
    if (lookup.status === "pending") { memory.set(account, { ...intent, outcome: "uncertain" }); return null; }
    if (lookup.status === "committed") intent = { ...intent, receipt: lookup.receipt, outcome: "confirmed" };
   }
  }
  if (intent.outcome !== "confirmed") {
   if (intent.kind === "idea_attachment") {
    const receipt = await client.attachIdeaToProject(intent.input, signal);
    if (!receipt) return null; intent = { ...intent, outcome: "confirmed", receipt };
   } else {
    const receipt = await client.promoteStandaloneWorkspace(intent.input, signal);
    if (!receipt) return null; intent = { ...intent, outcome: "confirmed", receipt };
   }
  }
  if (signal.aborted || !memory.isCurrent(account)) return null;
  if (!memory.set(account, intent)) throw new Error("Unverified lifecycle receipt"); return memory.get(account, intent.kind);
 } catch (error) {
  const pending = memory.get(account, intent.kind);
  if (pending?.input.requestKey === intent.input.requestKey && pending.outcome !== "confirmed") memory.set(account, { ...pending, outcome: "uncertain" });
  throw error;
 }
}

