import { redirect } from "next/navigation";

/** The old Identity page is retired; older links land on the brand's Inspiration step. */
export default async function ProjectIdentityPage({ params }: { params: Promise<{ projectId: string }> }) {
  redirect(`/brands/account/${(await params).projectId.toLowerCase()}/inspiration`);
}
