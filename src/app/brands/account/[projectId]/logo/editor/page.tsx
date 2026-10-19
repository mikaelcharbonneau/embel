import { redirect } from "next/navigation";
export default async function LogoEditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const projectId = (await params).projectId.toLowerCase();
  redirect(`/brands/account/${projectId}/logo`);
}
