import type { Metadata } from "next";
import { BrandAssetsPage } from "@/components/visual-directions/brand-assets-page";
export const metadata: Metadata = { title: "Brand assets" };
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  return <BrandAssetsPage projectId={(await params).projectId.toLowerCase()} />;
}
