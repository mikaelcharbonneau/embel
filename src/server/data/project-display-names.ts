import "server-only";
import { z } from "zod";
import { contextDisplayName } from "@/domain/projects";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

/** The name people see for a project, the same rule as the project bar: the
 * name read from its current revision (see `readProjectDisplayNames`), otherwise
 * the saved project title. */
export function projectDisplayName(title: string, revisionName: string | null | undefined, maxLength: number) {
  const name = revisionName?.trim() || title;
  return name.length > maxLength ? `${name.slice(0, maxLength - 1).trimEnd()}…` : name;
}

const revisionNameSchema = z.object({
  project_id: z.uuid(),
  owner_id: z.uuid(),
  revision: z.number().int().positive(),
  selected_name: z.string().nullable(),
  // Absent on revisions saved before Rename existed.
  display_name: z.string().nullable().optional(),
});
type RevisionName = z.infer<typeof revisionNameSchema>;
// Keeps each filtered read URL short; listings carry at most 100 projects.
const CHUNK_SIZE = 25;

async function readChunk(
  auth: AuthenticatedContext,
  pairs: readonly (readonly [string, number])[],
): Promise<RevisionName[] | null> {
  try {
    const { data, error } = await auth.client
      .from("project_revisions")
      .select("project_id,owner_id,revision,selected_name:context->>selectedName,display_name:context->>displayName")
      .eq("owner_id", auth.userId)
      .or(pairs.map(([id, revision]) => `and(project_id.eq.${id},revision.eq.${revision})`).join(","))
      .limit(pairs.length);
    if (error) return null;
    const rows = z.array(revisionNameSchema).max(pairs.length).safeParse(data);
    return rows.success ? rows.data : null;
  } catch {
    return null;
  }
}

/** Each project's visible name from its current saved revision (the name given
 * with Rename, else the chosen brand name), through the same owner-scoped RLS
 * read as the project page. Names are display metadata only: a failed read
 * keeps the saved titles, while a foreign row fails closed. */
export async function readProjectDisplayNames(
  auth: AuthenticatedContext,
  projects: readonly { id: string; current_revision: number }[],
) {
  const wanted = new Map(projects.map((project) => [project.id.toLowerCase(), project.current_revision] as const));
  const pairs = [...wanted];
  const chunks = Array.from({ length: Math.ceil(pairs.length / CHUNK_SIZE) }, (_, index) =>
    pairs.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
  );
  const replies = await Promise.all(chunks.map((chunk) => readChunk(auth, chunk)));
  const names = new Map<string, string>();
  for (const row of replies.flatMap((rows) => rows ?? [])) {
    if (row.owner_id !== auth.userId) throw new ApiError("integration_unavailable");
    const id = row.project_id.toLowerCase(),
      name = contextDisplayName({ displayName: row.display_name, selectedName: row.selected_name });
    if (wanted.get(id) === row.revision && name) names.set(id, name);
  }
  return names;
}
