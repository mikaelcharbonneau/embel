import type { Metadata } from "next";
import { LogoOutputPage } from "@/components/identity/logo-output-page";
export const metadata: Metadata = { title: "Brand files" };
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  return <LogoOutputPage projectId={(await params).projectId.toLowerCase()} stage="deliverables" />;
}
