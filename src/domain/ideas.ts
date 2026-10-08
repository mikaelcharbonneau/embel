import { z } from "zod";
import { compareProjectCursors, projectCursorSchema } from "./project-pages";
import { createProjectInputSchema } from "./projects";

// Field bounds are independent of the full serialized UTF-8 mutation body limit.
export const IDEA_MUTATION_MAX_BYTES = 32_768;
export const ideaStateSchema = z.enum(["to_explore", "developing", "used"]);
export type IdeaState = z.infer<typeof ideaStateSchema>;

const ideaDetailsSchema = z.strictObject({
  problem: z.string().max(2000).default(""),
  audience: z.string().max(2000).default(""),
  solution: z.string().max(2000).default(""),
  differentiation: z.string().max(2000).default(""),
  revenueHypotheses: z.string().max(2000).default(""),
  validationSteps: z.string().max(2000).default(""),
  notes: z.string().max(2000).default(""),
});

/** User-authored capture, including unvalidated hypotheses; never Strategy approval. */
export const ideaContentSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(12000).default(""),
  theme: z.string().max(120).default(""),
  state: ideaStateSchema.default("to_explore"),
  details: ideaDetailsSchema.default(() => ideaDetailsSchema.parse({})),
});
export type IdeaContent = z.infer<typeof ideaContentSchema>;

const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const exactTimestampSchema = projectCursorSchema.shape.createdAt;
const sameUuid = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export const createIdeaInputSchema = z.strictObject({
  requestKey: z.uuid(),
  content: ideaContentSchema,
});
export const updateIdeaInputSchema = z.strictObject({
  requestKey: z.uuid(),
  expectedRevision: revisionSchema,
  content: ideaContentSchema,
});
export const createIdeaBrandInputSchema = z.strictObject({
  requestKey: z.uuid(),
  expectedRevision: revisionSchema,
});

export const ideaSummarySchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.uuid(),
  revision: revisionSchema,
  title: z.string().trim().min(1).max(160),
  description: z.string().max(12000),
  theme: z.string().max(120),
  state: ideaStateSchema,
  createdAt: exactTimestampSchema,
  updatedAt: exactTimestampSchema,
});
export type IdeaSummary = z.infer<typeof ideaSummarySchema>;

export const ideaLinkSchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.uuid(),
  ideaId: z.uuid(),
  ideaRevision: revisionSchema,
  projectId: z.uuid(),
  requestKey: z.uuid(),
  createdAt: exactTimestampSchema,
});
export type IdeaLink = z.infer<typeof ideaLinkSchema>;

export const ideaRecordSchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.uuid(),
  revision: revisionSchema,
  content: ideaContentSchema,
  createdAt: exactTimestampSchema,
  updatedAt: exactTimestampSchema,
  links: z.array(ideaLinkSchema).max(100),
}).superRefine((idea, ctx) => {
  const linkIds = new Set(idea.links.map(link => link.id.toLowerCase()));
  const projectIds = new Set(idea.links.map(link => link.projectId.toLowerCase()));
  if (linkIds.size !== idea.links.length || projectIds.size !== idea.links.length ||
      idea.links.some(link => !sameUuid(link.ownerId, idea.ownerId) || !sameUuid(link.ideaId, idea.id) || link.ideaRevision > idea.revision)) {
    ctx.addIssue({ code: "custom", path: ["links"], message: "Idea links must be owned, unique and bound to an existing revision of this idea" });
  }
});
export type IdeaRecord = z.infer<typeof ideaRecordSchema>;
export const ideaResponseSchema = z.strictObject({ idea: ideaRecordSchema });

export const listIdeasInputSchema = z.strictObject({
  cursor: projectCursorSchema.optional(),
  limit: z.number().int().min(1).max(50).default(25),
  search: z.string().trim().max(200).default(""),
  state: ideaStateSchema.optional(),
});

const ideaCursor = (idea: IdeaSummary) => ({ id: idea.id, createdAt: idea.createdAt });
export const ideaPageSchema = z.strictObject({
  ownerId: z.uuid(),
  items: z.array(ideaSummarySchema).max(50),
  nextCursor: projectCursorSchema.nullable(),
}).superRefine((page, ctx) => {
  const last = page.items.at(-1);
  if (page.items.some(idea => !sameUuid(idea.ownerId, page.ownerId)) ||
      new Set(page.items.map(idea => idea.id.toLowerCase())).size !== page.items.length ||
      page.items.some((idea, index) => index > 0 && compareProjectCursors(ideaCursor(page.items[index - 1]!), ideaCursor(idea)) <= 0) ||
      (page.nextCursor && (!last || page.nextCursor.id !== last.id || page.nextCursor.createdAt !== last.createdAt))) {
    ctx.addIssue({ code: "custom", message: "Idea pages must be owned, unique, ordered and anchored to their final row" });
  }
});
export type IdeaPage = z.infer<typeof ideaPageSchema>;

export const ideaBrandResponseSchema = z.strictObject({
  idea: ideaRecordSchema,
  link: ideaLinkSchema,
}).superRefine(({ idea, link }, ctx) => {
  if (!sameUuid(link.ownerId, idea.ownerId) || !sameUuid(link.ideaId, idea.id) || link.ideaRevision > idea.revision) {
    ctx.addIssue({ code: "custom", path: ["link"], message: "The brand link must belong to this idea and its owned source revision" });
  }
});
export type IdeaBrandResponse = z.infer<typeof ideaBrandResponseSchema>;

export const ideaSourceResponseSchema = z.strictObject({
  ownerId: z.uuid(),
  projectId: z.uuid(),
  source: z.strictObject({ link: ideaLinkSchema, content: ideaContentSchema }).nullable(),
}).superRefine(({ ownerId, projectId, source }, ctx) => {
  if (source && (!sameUuid(source.link.ownerId, ownerId) || !sameUuid(source.link.projectId, projectId))) {
    ctx.addIssue({ code: "custom", path: ["source"], message: "The frozen idea source must belong to the returned owner and project" });
  }
});
export type IdeaSourceResponse = z.infer<typeof ideaSourceResponseSchema>;

/** The immutable association retains the remaining Idea details outside Strategy. */
export function ideaProjectInput(content: IdeaContent) {
  const source = ideaContentSchema.parse(content);
  return createProjectInputSchema.parse({
    title: source.title,
    scope: "complete_brand",
    context: {
      description: source.description.trim() || source.title,
      offering: source.details.solution.trim(),
      knownAudience: source.details.audience.trim(),
    },
  });
}
