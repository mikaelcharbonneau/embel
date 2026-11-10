import type { Metadata } from "next";
import { connection } from "next/server";
import { localRuntimeEnabled } from "@/server/local-chatgpt/bridge";
import { SettingsWorkspace } from "@/components/workspace/settings-workspace";

export const metadata: Metadata = { title: "Settings" };
export default async function SettingsPage() {
  // The local ChatGPT switch is read per request, never at build time.
  await connection();
  return <SettingsWorkspace localRuntimeEnabled={localRuntimeEnabled()} />;
}
