import type { Metadata } from "next";
import { InspirationWorkspace } from "@/components/inspiration/inspiration-workspace";
export const metadata: Metadata = { title: "Inspiration" };
export default async function InspirationPage({ params }: { params: Promise<{ projectId: string }> }) {
  return <InspirationWorkspace projectId={(await params).projectId.toLowerCase()} />;
}
