"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import type { StandaloneTool, StandaloneWorkspace } from "@/domain/standalone-workspaces";
import type { StandalonePromotionReceipt, StandalonePromotionSelection } from "@/domain/standalone-promotion";
import type { DomainDraft } from "@/features/domain-workspace/draft";
import type { HandlesState } from "@/features/handles-workspace/domain";
import type { TrademarkDraft } from "@/features/trademark-workspace/domain";
import { StandalonePromotionControl } from "@/features/brand-lifecycle/promotion-control";
import type { LifecycleIntentMemory } from "@/features/brand-lifecycle/intent-memory";
import type { StandaloneDraftMemory } from "./standalone-draft-memory";

type SavedPayload = DomainDraft | HandlesState | TrademarkDraft;
type SavedSelection = { workspaceId: string; revision: number; selection: StandalonePromotionSelection };
type WorkspaceState = { workspace: StandaloneWorkspace<SavedPayload> | null; dirty: boolean; pending: boolean; canEdit: boolean };
const empty = () => null;
const noSubscription = () => () => undefined;
const toolLabels = { domains: "Domains", handles: "Handles", trademarks: "Trademarks" };

/** Callback objects identify a choice only. Its authority is the persisted account envelope. */
function includesSelection(workspace: StandaloneWorkspace<SavedPayload>, selection: StandalonePromotionSelection): boolean {
  if (workspace.tool !== selection.tool) return false;
  if (selection.tool === "domains") return "candidates" in workspace.payload && workspace.payload.candidates.includes(selection.domain);
  if (selection.tool === "handles") return "bundles" in workspace.payload && workspace.payload.bundles.some(bundle => bundle.id === selection.bundleId);
  return "markName" in workspace.payload && workspace.payload.markName.trim().length > 0;
}

/** Opens only after an explicit saved choice, or to recover the same owner's original request. */
export function useSavedStandalonePromotion(tool: StandaloneTool, state: WorkspaceState, memory: StandaloneDraftMemory) {
  const { session, isCurrent, lifecycleMemory } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const [chosen, setChosen] = useState<SavedSelection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const read = useCallback(() => account ? lifecycleMemory?.get(account, "standalone_promotion") ?? null : null, [account, lifecycleMemory]);
  const intent = useSyncExternalStore(lifecycleMemory?.subscribe ?? noSubscription, read, empty);
  const promotion = intent?.kind === "standalone_promotion" ? intent : null;
  const unresolved = promotion && promotion.outcome !== "confirmed" ? promotion : null;
  const blockedByOtherTool = unresolved && unresolved.input.selection.tool !== tool;
  const workspace = state.workspace;
  // Keep the recovered control mounted through confirmation so its verified callback can finish.
  const retained = promotion && workspace?.id === promotion.input.workspaceId && promotion.input.selection.tool === tool &&
    (unresolved || !chosen || (chosen.workspaceId === promotion.input.workspaceId && chosen.revision === promotion.input.expectedWorkspaceRevision && JSON.stringify(chosen.selection) === JSON.stringify(promotion.input.selection))) ? promotion : null;
  const selected = retained ? retained.input.selection
    : chosen && workspace?.id === chosen.workspaceId && workspace.revision === chosen.revision && includesSelection(workspace, chosen.selection) ? chosen.selection : null;
  const confirmedOlderSource = retained?.outcome === "confirmed" && workspace?.revision !== retained.input.expectedWorkspaceRevision;
  const record = account ? memory.get(account, tool) : null;

  function select(selection: StandalonePromotionSelection) {
    // Retained callbacks must obey synchronous provider and draft fences, not just the last render.
    if (!account || !isCurrent(account) || !memory.isCurrent(account) || !lifecycleMemory?.isCurrent(account) || selection.tool !== tool) return;
    const current = memory.get(account, tool);
    const pending = lifecycleMemory.get(account, "standalone_promotion");
    if (pending?.kind === "standalone_promotion" && pending.outcome !== "confirmed") return;
    if (current?.conflict) { setNotice("Resolve the workspace conflict before creating a brand."); return; }
    if (!state.canEdit || current?.pending) { setNotice("Wait for your changes to finish saving before creating a brand."); return; }
    if (!current?.workspace || current.dirty) { setNotice("Your changes are still saving. Create the brand once they are saved."); return; }
    const saved = current.workspace as StandaloneWorkspace<SavedPayload>;
    if (state.workspace?.id !== saved.id || state.workspace.revision !== saved.revision) { setNotice("The saved workspace changed. Choose the result again before creating a brand."); return; }
    if (!includesSelection(saved, selection)) { setNotice("Choose a saved result before creating a brand."); return; }
    setNotice(null);
    setChosen({ workspaceId: saved.id, revision: saved.revision, selection });
  }

  const controls = <>
    {notice && <p role="status">{notice}</p>}
    {blockedByOtherTool && <p role="status">Check the original {toolLabels[unresolved.input.selection.tool]} promotion before creating another brand. <Link href={`/${unresolved.input.selection.tool}`}>Open {toolLabels[unresolved.input.selection.tool]}</Link></p>}
    {confirmedOlderSource && <p role="status">The created brand keeps its original saved version {retained.input.expectedWorkspaceRevision}. Choose a current saved result to create another brand.</p>}
    {!retained && chosen && workspace && workspace.revision !== chosen.revision && <p role="status">The saved workspace changed. Choose the result again before creating a brand.</p>}
    {!blockedByOtherTool && account && lifecycleMemory && workspace && selected && <SavedPromotionNavigation key={`${workspace.id}:${retained?.input.expectedWorkspaceRevision ?? chosen?.revision}:${JSON.stringify(selected)}`} account={account} workspace={workspace} selection={selected} dirty={state.dirty || Boolean(record?.conflict) || Boolean(confirmedOlderSource)} pending={state.pending} memory={memory} lifecycleMemory={lifecycleMemory} />}
  </>;
  return { select: lifecycleMemory ? select : undefined, controls };
}

function SavedPromotionNavigation({ account, workspace, selection, dirty, pending, memory, lifecycleMemory }: {
  account: VerifiedAccount; workspace: StandaloneWorkspace<SavedPayload>; selection: StandalonePromotionSelection;
  dirty: boolean; pending: boolean; memory: StandaloneDraftMemory; lifecycleMemory: LifecycleIntentMemory;
}) {
  const router = useRouter();
  const { isCurrent } = useAccountSession();
  const navigated = useRef<string | null>(null);
  function onCreated(receipt: StandalonePromotionReceipt) {
    if (!isCurrent(account) || !memory.isCurrent(account) || !lifecycleMemory.isCurrent(account)) return;
    const result = lifecycleMemory.get(account, "standalone_promotion");
    const current = memory.get(account, workspace.tool);
    // Do not leave edits made while the request was in flight. The verified receipt remains openable.
    if (!current || current.dirty || current.pending || current.conflict || result?.kind !== "standalone_promotion" || result.outcome !== "confirmed" || !result.receipt || result.receipt.requestKey !== receipt.requestKey || result.receipt.project.id !== receipt.project.id || navigated.current === receipt.requestKey) return;
    navigated.current = receipt.requestKey;
    router.push(`/brands/account/${result.receipt.project.id}`);
  }
  return <StandalonePromotionControl account={account} workspace={workspace} selection={selection} dirty={dirty} pending={pending} memory={lifecycleMemory} onCreated={onCreated} />;
}
