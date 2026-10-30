import type { Metadata } from "next";
import { redirect } from "next/navigation";
export const metadata: Metadata = { title: "Brand board" };
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  redirect(`/brands/account/${(await params).projectId.toLowerCase()}/logo/directions`);
}
