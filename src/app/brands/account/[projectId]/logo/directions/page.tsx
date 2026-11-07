import type { Metadata } from "next";
import { VisualDirectionsPage } from "@/components/visual-directions/visual-directions-page";
export const metadata: Metadata = { title: "Creative direction" };
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  return <VisualDirectionsPage projectId={(await params).projectId.toLowerCase()} />;
}
