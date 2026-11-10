import "server-only";
import { z } from "zod";
import {
  activeJobStates,
  jobActivityEntrySchema,
  jobActivitySchema,
  type JobActivityEntry,
} from "@/domain/job-activity";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { projectDisplayName, readSelectedProjectNames } from "./project-display-names";

const columns = "id,owner_id,project_id,operation,state,progress,created_at,finished_at";
const storedJobSchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  project_id: z.uuid(),
  operation: jobActivityEntrySchema.shape.operation,
  state: jobActivityEntrySchema.shape.state,
  progress: jobActivityEntrySchema.shape.progress,
  created_at: jobActivityEntrySchema.shape.createdAt,
  finished_at: jobActivityEntrySchema.shape.finishedAt,
});
const projectSchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  title: z.string().min(1).max(160),
  current_revision: z.number().int().positive(),
});
function verified<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  return parsed.data;
}

/** Existing authenticated RLS reads only; no input, output, lease or provider secret is returned. */
export async function listJobActivity(auth: AuthenticatedContext) {
  const activeReply = await auth.client
    .from("jobs")
    .select(columns)
    .eq("owner_id", auth.userId)
    .in("state", [...activeJobStates])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(20);
  // Read recent rows second so their observations supersede the active snapshot.
  const recentReply = await auth.client
    .from("jobs")
    .select(columns)
    .eq("owner_id", auth.userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(20);
  if (activeReply.error || recentReply.error) throw new ApiError("integration_unavailable");
  const active = verified(z.array(storedJobSchema).max(20), activeReply.data);
  const recent = verified(z.array(storedJobSchema).max(20), recentReply.data);
  if ([...active, ...recent].some((row) => row.owner_id !== auth.userId)) throw new ApiError("integration_unavailable");
  const projectIds = [...new Set([...active, ...recent].map((row) => row.project_id))];
  if (!projectIds.length) return jobActivitySchema.parse({ ownerId: auth.userId, active: [], recent: [] });
  const projectReply = await auth.client
    .from("projects")
    .select("id,owner_id,title,current_revision")
    .eq("owner_id", auth.userId)
    .in("id", projectIds)
    .limit(40);
  if (projectReply.error) throw new ApiError("integration_unavailable");
  const projects = verified(z.array(projectSchema).max(40), projectReply.data);
  if (
    projects.some((row) => row.owner_id !== auth.userId || !projectIds.includes(row.id)) ||
    new Set(projects.map((row) => row.id)).size !== projects.length
  )
    throw new ApiError("integration_unavailable");
  // Show the chosen brand name, as the project bar and cards do.
  const names = await readSelectedProjectNames(auth, projects);
  const titles = new Map(
    projects.map((row) => [row.id, projectDisplayName(row.title, names.get(row.id.toLowerCase()), 160)]),
  );
  function entry(row: z.infer<typeof storedJobSchema>): JobActivityEntry {
    const title = titles.get(row.project_id);
    if (!title) throw new ApiError("integration_unavailable");
    return {
      id: row.id,
      ownerId: row.owner_id,
      projectId: row.project_id,
      projectTitle: title,
      operation: row.operation,
      state: row.state,
      progress: row.progress,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }
  // The two reads can straddle a completion. Prefer the later recent observation.
  const newest = new Map([...active, ...recent].map((row) => [row.id, row]));
  const activeRows = [...newest.values()]
    .filter((row) => activeJobStates.some((state) => state === row.state))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id))
    .slice(0, 20);
  const activeIds = new Set(activeRows.map((row) => row.id));
  return verified(jobActivitySchema, {
    ownerId: auth.userId,
    active: activeRows.map(entry),
    recent: recent.filter((row) => !activeIds.has(row.id)).map(entry),
  });
}
