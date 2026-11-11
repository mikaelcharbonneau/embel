import { z } from "zod";
import { accountProjectSchema } from "./project-api";
import {
  currentNameSelectionSchema,
  getNamingReadiness,
  namingPreferenceRevisionSchema,
  namingReadinessSchema,
  namingSessionSchema,
  projectNamePageSchema,
} from "./project-naming";

// The project naming overview returned by `get_project_naming`. Naming runs on the generation
// engine; this overview still carries three fields the old worker system filled. Nothing in
// the app reads them, and the database holds no rows for them (`naming_batches` is empty), so
// they are checked only for ownership and left otherwise unparsed:
// - `batches`: the old worker's request history page (always empty now);
// - `jobs`: the old worker's job list (always empty now);
// - `availability`: written by `get_naming_availability`, which still describes the retired
//   ChatGPT-plan runtime, so its reasons and limits are not modelled.
const ownershipFields = { ownerId: z.uuid(), projectId: z.uuid() };
const sameScope = (left: { ownerId: string; projectId: string }, right: { ownerId: string; projectId: string }) =>
  left.ownerId === right.ownerId && left.projectId === right.projectId;

const legacyBatchPageSchema = z.looseObject({ ...ownershipFields, items: z.array(z.unknown()).max(100) });
const legacyAvailabilitySchema = z.looseObject({
  status: z.enum(["available", "unavailable"]),
  operation: z.literal("naming.generate"),
});

const unavailableScreeningSchema = z.strictObject({
  status: z.literal("not_checked"),
  reason: z.literal("integration_unavailable"),
});
const namingScreeningSchema = z.strictObject({
  domains: unavailableScreeningSchema,
  handles: unavailableScreeningSchema,
  trademarks: unavailableScreeningSchema,
});

export const projectNamingOverviewSchema = z
  .strictObject({
    project: accountProjectSchema.strict(),
    readiness: namingReadinessSchema,
    session: namingSessionSchema.nullable(),
    preferences: namingPreferenceRevisionSchema.nullable(),
    currentSelection: currentNameSelectionSchema.nullable(),
    batches: legacyBatchPageSchema,
    candidates: projectNamePageSchema,
    availability: legacyAvailabilitySchema,
    jobs: z.array(z.unknown()).max(20),
    screening: namingScreeningSchema,
  })
  .superRefine((overview, ctx) => {
    const { project, session, preferences, currentSelection } = overview;
    const scope = { ownerId: project.owner_id, projectId: project.id };
    const expectedReadiness = getNamingReadiness(project.context, project.scope);
    if (JSON.stringify(overview.readiness) !== JSON.stringify(expectedReadiness))
      ctx.addIssue({
        code: "custom",
        path: ["readiness"],
        message: "Readiness must describe this saved project and scope",
      });
    if (
      ![
        overview.batches,
        overview.candidates,
        ...(session ? [session] : []),
        ...(preferences ? [preferences] : []),
        ...(currentSelection ? [currentSelection.selection] : []),
      ].every((row) => sameScope(scope, row))
    )
      ctx.addIssue({ code: "custom", message: "Every overview row must belong to this project and owner" });
    if (!session) {
      if (
        preferences ||
        currentSelection ||
        overview.batches.items.length ||
        overview.candidates.items.length ||
        overview.jobs.length
      )
        ctx.addIssue({ code: "custom", path: ["session"], message: "Persisted naming records require a session" });
    } else {
      if (
        (preferences?.version ?? 0) !== session.currentPreferencesVersion ||
        (currentSelection?.selection.id ?? null) !== session.currentSelectionId
      )
        ctx.addIssue({
          code: "custom",
          path: ["session"],
          message: "Session pointers must match current preferences and selection",
        });
      if (
        session.currentPreferencesVersion === 0 &&
        (session.latestBatchSequence !== 0 || overview.batches.items.length || overview.jobs.length)
      )
        ctx.addIssue({
          code: "custom",
          path: ["session"],
          message: "Generation requires an explicitly saved preference version",
        });
    }
    if (
      currentSelection &&
      (project.context.selectedName !== currentSelection.candidate.value ||
        project.context.intake.suppliedName !== currentSelection.candidate.value ||
        currentSelection.selection.projectRevision > project.current_revision)
    )
      ctx.addIssue({
        code: "custom",
        path: ["currentSelection"],
        message: "Current selected name must match both project fields and a saved revision",
      });
    if (overview.availability.status === "available" && !overview.readiness.ready)
      ctx.addIssue({
        code: "custom",
        path: ["availability"],
        message: "Generation cannot be available before project readiness",
      });
  });
export type ProjectNamingOverview = z.infer<typeof projectNamingOverviewSchema>;
