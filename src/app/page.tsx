import { HomeWorkspace } from "@/components/workspace/home-workspace";
import { scopeFromQuery } from "./_home/scope-query";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ scope?: string | string[] }> }) {
  return <HomeWorkspace initialScope={scopeFromQuery((await searchParams).scope)} />;
}
