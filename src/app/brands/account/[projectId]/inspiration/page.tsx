import { InspirationWorkspace } from "@/components/inspiration/inspiration-workspace";
export default async function InspirationPage({ params }: { params: Promise<{ projectId: string }> }) {
  return <InspirationWorkspace projectId={(await params).projectId.toLowerCase()} />;
}
