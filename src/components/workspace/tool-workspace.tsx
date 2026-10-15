"use client";

import { useState } from "react";
import { SettingsWorkspace } from "./settings-workspace";
import { AccountStatus, useAccountSession } from "./account-session";
import { NamesWorkspace } from "@/components/naming/names-workspace";
import { AssetsWorkspace } from "@/components/assets/assets-workspace";
import { IdeasWorkspace } from "@/components/ideas/ideas-workspace";
import { AccountDomainsWorkspace } from "@/components/tools/domain-account-workspace";
import { HandlesAccountEditor } from "@/components/tools/handles-account-editor";
import { TrademarkAccountEditor } from "@/components/tools/trademark-account-editor";
import { StandaloneProjectPicker, type StandaloneProjectSelection } from "@/components/tools/standalone-project-picker";
import { DomainsWorkspace, type DomainSearchAdapter } from "@/features/domain-workspace";
import { HandlesWorkspace } from "@/features/handles-workspace";
import { TrademarkWorkspace, createTrademarkDraft, serializeTrademarkDraftPreview } from "@/features/trademark-workspace";

export const toolNames = ["ideas", "names", "handles", "domains", "trademarks", "assets", "settings"] as const;
export type ToolName = typeof toolNames[number];

type StandaloneToolName = "domains" | "handles" | "trademarks";

const unverifiedDomainAdapters: Record<"checking" | "signed_out" | "unavailable" | "error", DomainSearchAdapter> = {
  checking: { status: "unavailable", reason: "Checking your account before enabling live domain availability and pricing." },
  signed_out: { status: "unavailable", reason: "Sign in to check live domain availability and prices, and save your shortlist. Purchases are unavailable." },
  unavailable: { status: "unavailable", reason: "Your account could not be verified. Recheck your account to enable live domain checks and pricing. Purchases are unavailable." },
  error: { status: "unavailable", reason: "Your account could not be verified. Recheck your account to enable live domain checks and pricing. Purchases are unavailable." },
};

function ManualTrademarkWorkspace({ draftControls }: { draftControls?: React.ReactNode }) {
  const [draft, setDraft] = useState(createTrademarkDraft);
  return <TrademarkWorkspace draftControls={draftControls} draft={draft} onChange={setDraft} onExportPreview={preview => {
    const raw = serializeTrademarkDraftPreview(preview);
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "embel-trademark-draft-preview.json";
    document.body.appendChild(link);
    try { link.click(); }
    finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }} />;
}

function StandaloneToolWorkspace({ tool }: { tool: StandaloneToolName }) {
  const { session, isCurrent, standaloneDrafts } = useAccountSession();
  const [selected, setSelected] = useState<{ ownerId: string; generation: number; project: StandaloneProjectSelection } | null>(null);
  // A refresh invalidates the source selection. Retained tool edits remain in the
  // shared provider memory and are recovered only by the matching verified owner.
  const project = session.status === "ready" && selected?.ownerId === session.userId && selected.generation === session.generation ? selected.project : null;
  const props = { memory: standaloneDrafts, importProjectId: project?.id, importProjectTitle: project?.title };
  // The manual fallback is a separate component, seeded only by the features'
  // empty defaults. It never receives a hidden account payload or saved sources.
  if (session.status !== "ready") {
    if (tool === "domains") return <DomainsWorkspace adapter={unverifiedDomainAdapters[session.status]} initialView="search" draftControls={<AccountStatus retainedEdits={standaloneDrafts.hasUnsaved()} />} />;
    if (tool === "handles") return <HandlesWorkspace draftControls={<AccountStatus retainedEdits={standaloneDrafts.hasUnsaved()} />} />;
    return <ManualTrademarkWorkspace draftControls={<AccountStatus retainedEdits={standaloneDrafts.hasUnsaved()} />} />;
  }
  const projectPicker = <StandaloneProjectPicker selectedProjectId={project?.id} onSelect={next => {
    if (session.status === "ready" && isCurrent(session)) setSelected(next ? { ownerId: session.userId, generation: session.generation, project: next } : null);
  }} />;
  if (tool === "domains") return <AccountDomainsWorkspace {...props} projectPicker={projectPicker} />;
  if (tool === "handles") return <HandlesAccountEditor {...props} projectPicker={projectPicker} />;
  return <TrademarkAccountEditor {...props} projectPicker={projectPicker} />;
}

export function ToolWorkspace({ tool, localRuntimeEnabled = false }: { tool: ToolName; localRuntimeEnabled?: boolean }) {
  if (tool === "settings") return <SettingsWorkspace localRuntimeEnabled={localRuntimeEnabled} />;
  if (tool === "ideas") return <IdeasWorkspace />;
  if (tool === "names") return <NamesWorkspace />;
  if (tool === "assets") return <AssetsWorkspace />;
  if (tool === "domains" || tool === "handles" || tool === "trademarks") return <StandaloneToolWorkspace key={tool} tool={tool} />;
  const unknownTool: never = tool;
  throw new Error(`Unknown Embel tool: ${unknownTool}`);
}
