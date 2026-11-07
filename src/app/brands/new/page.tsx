import { redirect } from "next/navigation";
import { homeHref, scopeFromQuery } from "../../_home/scope-query";

// Home starts every new project. Older links keep their chosen scope.
export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ scope?: string | string[] }> }) {
  redirect(homeHref(scopeFromQuery((await searchParams).scope)));
}
