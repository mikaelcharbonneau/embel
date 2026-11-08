import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { localRuntimeEnabled } from "@/server/local-chatgpt/bridge";
import { ToolWorkspace, type ToolName } from "@/components/workspace/tool-workspace";

const allowedTools = ["ideas", "names", "handles", "domains", "trademarks", "assets", "settings"] as const;

const titles: Record<ToolName, string> = {
  // The assets page appears as Library in the navigation.
  ideas: "Ideas", names: "Names", handles: "Handles", domains: "Domains", trademarks: "Trademarks", assets: "Library", settings: "Settings",
};

export function generateStaticParams() { return allowedTools.map((tool) => ({ tool })); }
export async function generateMetadata({ params }: { params: Promise<{ tool: string }> }): Promise<Metadata> {
  const { tool } = await params;
  // Never derive a title from an arbitrary path; unknown tools render the 404 page.
  return { title: Object.hasOwn(titles, tool) ? titles[tool as ToolName] : "Page not found" };
}
export default async function ToolPage({ params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  if (!allowedTools.includes(tool as ToolName)) notFound();
  if (tool === "settings") await connection();
  return <ToolWorkspace tool={tool as ToolName} localRuntimeEnabled={tool === "settings" && localRuntimeEnabled()} />;
}
