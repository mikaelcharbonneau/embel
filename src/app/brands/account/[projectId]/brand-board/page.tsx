import type { Metadata } from "next";
import { BrandBoardPage } from "@/components/logo-creation/brand-board-page";
export const metadata: Metadata = { title: "Brand board" };
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  return <BrandBoardPage projectId={(await params).projectId.toLowerCase()} />;
}
