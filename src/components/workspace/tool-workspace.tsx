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

export const toolNames = ["ideas", "names", "handles", "domains", "trademarks", "assets", "settings"] as const;
export type ToolName = typeof toolNames[number];

type StandaloneToolName = "domains" | "handles" | "trademarks";

function StandaloneToolWorkspace({ tool }: { tool: StandaloneToolName }) {
  const { session, isCurrent, standaloneDrafts } = useAccountSession();
  const [selected, setSelected] = useState<{ ownerId: string; generation: number; project: StandaloneProjectSelection } | null>(null);
  // A refresh invalidates the source selection. Retained tool edits remain in the
  // shared provider memory and are recovered only by the matching verified owner.
  const project = session.status === "ready" && selected?.ownerId === session.userId && selected.generation === session.generation ? selected.project : null;
  const props = { memory: standaloneDrafts, importProjectId: project?.id, importProjectTitle: project?.title };
  if (session.status !== "ready") return <section className="page"><h1>{tool === "domains" ? "Domains" : tool === "handles" ? "Handles" : "Trademarks"}</h1><AccountStatus retainedEdits={standaloneDrafts.hasUnsaved()} /></section>;
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
