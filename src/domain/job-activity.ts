import { z } from "zod";
import { jobStatusSchema } from "./jobs";
import { operationSchema } from "./providers";
import { projectStrategyHref } from "./project-handoff";

export const activeJobStates = ["queued", "running", "cancel_requested", "needs_reconciliation"] as const;
export const jobActivityEntrySchema = z.strictObject({
  id: z.uuid(), ownerId: z.uuid(), projectId: z.uuid(), projectTitle: z.string().min(1).max(160),
  operation: operationSchema, state: jobStatusSchema, progress: z.number().int().min(0).max(100),
  createdAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type JobActivityEntry = z.infer<typeof jobActivityEntrySchema>;
export const jobActivitySchema = z.strictObject({
  ownerId: z.uuid(), active: z.array(jobActivityEntrySchema).max(20), recent: z.array(jobActivityEntrySchema).max(20),
}).superRefine((value, ctx) => {
  const rows = [...value.active, ...value.recent];
  if (rows.some(row => row.ownerId !== value.ownerId) || new Set(rows.map(row => row.id)).size !== rows.length)
    ctx.addIssue({ code: "custom", message: "Activity must contain unique jobs from the verified owner" });
  if (value.active.some(row => !activeJobStates.some(state => state === row.state)))
    ctx.addIssue({ code: "custom", path: ["active"], message: "Active activity must represent unfinished work" });
});
export type JobActivity = z.infer<typeof jobActivitySchema>;

const operationLabels: Record<JobActivityEntry["operation"], string> = {
  "strategy.reformulate": "Brief", "strategy.competitors": "Competitors", "strategy.audience": "Audience",
  "strategy.personality": "Personality", "strategy.positioning": "Positioning", "strategy.slogan": "Slogan", "naming.generate": "Naming",
  "ideas.explore": "Ideas", "identity.image": "Identity images", "identity.vector": "Vector output", "brand.export": "Brand export",
  "identity.logo_concept": "Logo concepts", "identity.logo_refine": "Logo refinement", "identity.logo_vectorize": "Logo vector",
  "identity.logo_vector_propose": "Vector logo", "identity.logo_directions": "Creative directions", "identity.logo_export": "Brand files",
};
export const jobOperationLabel = (operation: JobActivityEntry["operation"]) => operationLabels[operation];
export function jobActivityHref(job: Pick<JobActivityEntry, "projectId" | "operation">) {
  if (job.operation.startsWith("strategy.")) return projectStrategyHref(job.projectId);
  const suffix: Partial<Record<JobActivityEntry["operation"], string>> = {
    "naming.generate": "/naming", "identity.image": "/logo/directions", "identity.logo_concept": "/logo", "identity.logo_refine": "/logo",
    "identity.logo_vector_propose": "/logo", "identity.logo_vectorize": "/logo", "identity.logo_directions": "/logo/directions", "identity.logo_export": "/logo/deliverables",
  };
  return `/brands/account/${job.projectId}${suffix[job.operation] ?? ""}`;
}
