"use client";

import { useState } from "react";
import { clearLocalDrafts, useLocalDrafts } from "./local-drafts";
import { AccountStatus, useAccountSession } from "./account-session";
import { NamesWorkspace } from "@/components/naming/names-workspace";
import { AssetsWorkspace } from "@/components/assets/assets-workspace";
import { RecordedUsageSection } from "./recorded-usage";
import { LocalChatGPTSettings } from "./local-chatgpt-settings";
import { StrategyRuntimeSettings } from "./strategy-runtime-settings";
import { IdeasWorkspace } from "@/components/ideas/ideas-workspace";
import { AccountDomainsWorkspace } from "@/components/tools/domain-account-workspace";
import { HandlesAccountEditor } from "@/components/tools/handles-account-editor";
import { TrademarkAccountEditor } from "@/components/tools/trademark-account-editor";
import { StandaloneProjectPicker, type StandaloneProjectSelection } from "@/components/tools/standalone-project-picker";
import { DomainsWorkspace } from "@/features/domain-workspace";
import { HandlesWorkspace } from "@/features/handles-workspace";
import { TrademarkWorkspace, createTrademarkDraft, serializeTrademarkDraftPreview } from "@/features/trademark-workspace";

export const toolNames = ["ideas", "names", "handles", "domains", "trademarks", "assets", "settings"] as const;
export type ToolName = typeof toolNames[number];

function SettingsWorkspace({ localRuntimeEnabled = false }: { localRuntimeEnabled?: boolean }) {
  const { session } = useAccountSession();
  const { drafts, storage } = useLocalDrafts();
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState("");
  return <div className="page settings-page"><div className="page-heading"><h1>Settings</h1></div><section className="settings-section"><div><h2>Workspace</h2><p>Drafts and preferences on this device.</p></div><div className="settings-panel"><div className="setting-row"><div><strong>Browser drafts</strong><p>{drafts.length} {drafts.length === 1 ? "draft" : "drafts"} {storage === "available" ? "stored in this browser" : "currently in this tab"}. Account copies are saved separately when you choose.</p></div><span className="small-badge">Local preview</span></div><div className="setting-row"><div><strong>Clear local drafts</strong><p>This removes every draft from this browser.</p></div><button className="button secondary small" disabled={!drafts.length && storage !== "invalid"} onClick={() => setConfirmClear(true)}>Clear drafts</button></div>{confirmClear && <div className="inline-confirm settings-confirm" role="alert"><p>Delete all {drafts.length} local {drafts.length === 1 ? "draft" : "drafts"}? This cannot be undone.</p><div><button className="button secondary small" onClick={() => setConfirmClear(false)}>Keep drafts</button><button className="button danger small" onClick={() => { const persisted = clearLocalDrafts(); setConfirmClear(false); setMessage(persisted ? "Local drafts cleared." : "Drafts removed from this tab. Previously saved drafts may return after a reload because browser storage is unavailable."); }}>Delete all drafts</button></div></div>}{message && <p className="form-success" role="status">{message}</p>}</div></section><section className="settings-section"><div><h2>Connections</h2><p>Available services for this workspace.</p></div><div className="settings-panel">{[{ title: "Cloud account", text: session.status === "ready" ? "A verified account session is connected. Open Brands to view saved account projects." : "No verified account session is connected. Use Sign in to access an existing account." }, { title: "Availability checks", text: "Domains, handles, and trademarks are not connected." }].map((item) => <div key={item.title} className="setting-row"><div><strong>{item.title}</strong><p>{item.text}</p></div><span className="connection-status"><span />{item.title === "Cloud account" && session.status === "ready" ? "Connected" : "Not connected"}</span></div>)}{!localRuntimeEnabled && <><StrategyRuntimeSettings /><div className="setting-row"><div><strong>Images</strong><p>Text readiness does not confirm image access. Image availability is checked separately in Identity.</p></div><span className="connection-status"><span />Not checked here</span></div></>}</div></section><LocalChatGPTSettings enabled={localRuntimeEnabled} /><RecordedUsageSection /><section className="settings-section"><div><h2>Teamspace</h2></div><div className="settings-panel"><div className="setting-row"><p>Shared projects and collaboration will live here.</p><span className="small-badge">Coming soon</span></div></div></section></div>;
}

type StandaloneToolName = "domains" | "handles" | "trademarks";

function ManualTrademarkWorkspace() {
  const [draft, setDraft] = useState(createTrademarkDraft);
  return <TrademarkWorkspace draft={draft} onChange={setDraft} onExportPreview={preview => {
    const raw = serializeTrademarkDraftPreview(preview);
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "fluid-trademark-draft-preview.json";
    document.body.appendChild(link);
    try { link.click(); }
    finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }} />;
}

function ManualStandaloneToolWorkspace({ tool }: { tool: StandaloneToolName }) {
  if (tool === "domains") return <DomainsWorkspace />;
  if (tool === "handles") return <HandlesWorkspace />;
  return <ManualTrademarkWorkspace />;
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
  if (session.status !== "ready") return <><AccountStatus retainedEdits={standaloneDrafts.hasUnsaved()} /><ManualStandaloneToolWorkspace tool={tool} /></>;
  return <>
    <StandaloneProjectPicker selectedProjectId={project?.id} onSelect={next => {
      if (session.status === "ready" && isCurrent(session)) setSelected(next ? { ownerId: session.userId, generation: session.generation, project: next } : null);
    }} />
    {tool === "domains" ? <AccountDomainsWorkspace {...props} /> : tool === "handles" ? <HandlesAccountEditor {...props} /> : <TrademarkAccountEditor {...props} />}
  </>;
}

export function ToolWorkspace({ tool, localRuntimeEnabled = false }: { tool: ToolName; localRuntimeEnabled?: boolean }) {
  if (tool === "settings") return <SettingsWorkspace localRuntimeEnabled={localRuntimeEnabled} />;
  if (tool === "ideas") return <IdeasWorkspace />;
  if (tool === "names") return <NamesWorkspace />;
  if (tool === "assets") return <AssetsWorkspace />;
  if (tool === "domains" || tool === "handles" || tool === "trademarks") return <StandaloneToolWorkspace key={tool} tool={tool} />;
  const unknownTool: never = tool;
  throw new Error(`Unknown Fluid tool: ${unknownTool}`);
}
