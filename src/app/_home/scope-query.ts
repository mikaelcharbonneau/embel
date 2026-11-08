import { projectScopeSchema, type ProjectScope } from "@/domain/projects";

/** A `?scope=` value preselects what Home creates; anything else means a complete brand. */
export function scopeFromQuery(value: string | string[] | undefined): ProjectScope {
  const parsed = projectScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : "complete_brand";
}

/** Home's address with a preselected scope. A complete brand is Home's default. */
export function homeHref(scope: ProjectScope) {
  return scope === "complete_brand" ? "/" : `/?scope=${scope}`;
}
