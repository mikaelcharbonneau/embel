import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { localRuntimeEnabled } from "@/server/local-chatgpt/bridge";
import { ToolWorkspace, type ToolName } from "@/components/workspace/tool-workspace";

const allowedTools = ["ideas", "names", "handles", "domains", "trademarks", "assets", "settings"] as const;

export function generateStaticParams() { return allowedTools.map((tool) => ({ tool })); }
export async function generateMetadata({ params }: { params: Promise<{ tool: string }> }): Promise<Metadata> {
  const { tool } = await params;
  // The assets page appears as Library in the navigation.
  return { title: tool === "assets" ? "Library" : tool.charAt(0).toUpperCase() + tool.slice(1) };
}
export default async function ToolPage({ params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  if (!allowedTools.includes(tool as ToolName)) notFound();
  if (tool === "settings") await connection();
  return <ToolWorkspace tool={tool as ToolName} localRuntimeEnabled={tool === "settings" && localRuntimeEnabled()} />;
}
