import { z } from "zod";
import { nameTransformInputSchema, namingSourceSchema, transformNames, type NameTransformInput } from "./naming";
import { contextSnapshotSchema } from "./projects";
import { guidedUiSchema } from "./names-guided";

export const MAX_NAMES = 500;
export const MAX_RUNS = 100;
export const MAX_NAMES_BYTES = 4_000_000;

const kindSchema = z.enum(["affixes", "tweaks", "blend", "swap"]);
const operationSchema = z.enum(["lowercase", "uppercase", "titlecase", "remove_spaces", "hyphenate"]);
export const namesFormSchema = z.strictObject({
  kind: kindSchema, seed: z.string().max(160), prefixes: z.string().max(2000), suffixes: z.string().max(2000),
  separator: z.enum(["", " ", "-"]), operations: z.array(operationSchema).max(5),
  left: z.string().max(160), right: z.string().max(160), leftTake: z.string().max(3), rightDrop: z.string().max(3),
  find: z.string().max(160), replacement: z.string().max(160), match: z.enum(["first", "all"]),
});
const candidateSchema = z.strictObject({
  source: namingSourceSchema, context: contextSnapshotSchema,
  runId: z.uuid().nullable(), explanation: z.string().max(2000), favorite: z.boolean(), saved: z.boolean(),
});
const runSchema = z.strictObject({
  id: z.uuid(), input: nameTransformInputSchema, createdAt: z.iso.datetime({ offset: true }),
  parentId: z.uuid().nullable(), candidateIds: z.array(z.uuid()).max(64), context: contextSnapshotSchema,
  notes: z.array(z.string().max(2000)).max(100), truncated: z.boolean(),
});
// Form text keeps intentional whitespace while typing. A captured result uses the canonical context schema.
const workspaceContextSchema = contextSnapshotSchema.safeExtend({
  description: z.string().max(12000), knownAudience: z.string().max(2000),
});
export const namesUiSchema = z.strictObject({
  tab: z.enum(["library", "workshop", "assistant", "saved", "history"]), filter: z.enum(["retained", "favorite", "saved", "all"]),
  origin: z.enum(["all", "manual", "workshop"]), query: z.string().max(160), manualValue: z.string().max(160),
  manualOpen: z.boolean(), compareOpen: z.boolean(), comparisonIds: z.array(z.uuid()).max(3),
  activeRunId: z.uuid().nullable(), seedCandidateId: z.uuid().nullable(), form: namesFormSchema, context: workspaceContextSchema,
  guided: guidedUiSchema.optional(),
});

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const primarySeed = (input: NameTransformInput) => input.kind === "blend" ? input.left : input.seed;
const unique = (items: string[]) => new Set(items).size === items.length;

export const namesWorkspaceSchema = z.strictObject({
  version: z.literal(1), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  candidates: z.array(candidateSchema).max(MAX_NAMES), runs: z.array(runSchema).max(MAX_RUNS), ui: namesUiSchema,
}).superRefine((data, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const candidates = new Map(data.candidates.map(candidate => [candidate.source.id, candidate]));
  const runs = new Map(data.runs.map(run => [run.id, run]));
  if (candidates.size !== data.candidates.length || runs.size !== data.runs.length) fail("Duplicate identifiers");
  if (!unique(data.ui.comparisonIds) || data.ui.comparisonIds.some(id => !candidates.has(id))) fail("Invalid comparison selection");
  if (data.ui.activeRunId && !runs.has(data.ui.activeRunId)) fail("Missing selected run");
  if (data.ui.seedCandidateId && !candidates.has(data.ui.seedCandidateId)) fail("Missing seed candidate");
  if (data.ui.guided?.words.some(word => word.candidateId && candidates.get(word.candidateId)?.source.value !== word.value) || data.ui.guided?.savedLists.some(list => list.words.some(word => word.candidateId && candidates.get(word.candidateId)?.source.value !== word.value))) fail("Missing guided seed candidate");
  if (!unique(data.ui.form.operations)) fail("Duplicate tweak operations");
  const linkedIds = new Set<string>();
  for (const run of data.runs) {
    // Zod still invokes refinements for some nested bounds failures. Do not replay invalid input.
    const validInput = nameTransformInputSchema.safeParse(run.input);
    if (!validInput.success) continue;
    const parent = run.parentId ? candidates.get(run.parentId) : undefined;
    if (run.parentId && (!parent || primarySeed(run.input) !== parent.source.value)) fail("Invalid run parent");
    const output = transformNames(validInput.data);
    if (!unique(run.candidateIds) || output.candidates.length !== run.candidateIds.length || !equal(output.notes, run.notes) || output.truncated !== run.truncated) fail("Run results do not match their parameters");
    run.candidateIds.forEach((id, index) => {
      const candidate = candidates.get(id);
      const expected = output.candidates[index];
      if (!candidate || !expected || linkedIds.has(id)) { fail("Missing or repeated run result"); return; }
      linkedIds.add(id);
      const history = candidate.source.history;
      const last = history.at(-1);
      if (candidate.runId !== run.id || candidate.source.origin !== "workshop" || candidate.source.value !== expected.value || candidate.explanation !== expected.explanation || candidate.source.createdAt !== run.createdAt || !equal(candidate.context, run.context)) fail("Changed immutable result");
      if (!last || last.id !== run.id || last.createdAt !== run.createdAt || last.output !== candidate.source.value || !equal(last.input, run.input) || !equal(history.slice(0, -1), parent?.source.history ?? [])) fail("Changed transformation lineage");
    });
  }
  for (const candidate of data.candidates) {
    if (candidate.runId !== null && !linkedIds.has(candidate.source.id)) fail("Orphaned workshop result");
    if (candidate.runId === null && (candidate.source.origin !== "manual" || candidate.source.history.length !== 0 || candidate.explanation !== "Added manually")) fail("Invalid manual candidate");
  }
});

export type NamesWorkspace = z.infer<typeof namesWorkspaceSchema>;
export function readNamesBackup(raw: string): NamesWorkspace {
  if (new TextEncoder().encode(raw).byteLength > MAX_NAMES_BYTES) throw new Error("Choose a Names backup of at most 4 MB.");
  return namesWorkspaceSchema.parse(JSON.parse(raw));
}
export type NameCandidate = NamesWorkspace["candidates"][number];
export type NameRun = NamesWorkspace["runs"][number];
export type NamesForm = z.infer<typeof namesFormSchema>;
export type NamesUi = z.infer<typeof namesUiSchema>;

export function createEmptyNamesWorkspace(): NamesWorkspace {
  return {
    version: 1, revision: 0, candidates: [], runs: [],
    ui: {
      tab: "workshop", filter: "retained", origin: "all", query: "", manualValue: "", manualOpen: false,
      compareOpen: false, comparisonIds: [], activeRunId: null, seedCandidateId: null,
      context: contextSnapshotSchema.parse({}),
      form: { kind: "affixes", seed: "", prefixes: "", suffixes: "", separator: "", operations: ["lowercase"], left: "", right: "", leftTake: "1", rightDrop: "0", find: "", replacement: "", match: "all" },
    },
  };
}

/** The legacy payload retains its full 4 MB capacity; the envelope has separate headroom. */
export const NAMES_WORKSPACE_MUTATION_MAX_BYTES = MAX_NAMES_BYTES + 256;
export const NAMES_WORKSPACE_RESPONSE_MAX_BYTES = MAX_NAMES_BYTES + 1024;
const accountUuid = z.uuid().transform(value => value.toLowerCase());
export const saveNamesWorkspaceInputSchema = z.strictObject({
  requestKey: accountUuid,
  expectedRevision: z.number().int().nonnegative().max(2_147_483_646),
  payload: namesWorkspaceSchema,
});
export type SaveNamesWorkspaceInput = z.infer<typeof saveNamesWorkspaceInputSchema>;
export const accountNamesWorkspaceSchema = z.strictObject({
  id: accountUuid, ownerId: accountUuid, revision: z.number().int().positive().max(2_147_483_647),
  payload: namesWorkspaceSchema,
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
});
export type AccountNamesWorkspace = z.infer<typeof accountNamesWorkspaceSchema>;
export const namesWorkspaceResponseSchema = z.strictObject({
  ownerId: accountUuid, workspace: accountNamesWorkspaceSchema.nullable(),
}).superRefine((response, ctx) => {
  if (response.workspace && response.workspace.ownerId !== response.ownerId) {
    ctx.addIssue({ code: "custom", message: "Workspace must belong to response owner" });
  }
});
export type NamesWorkspaceResponse = z.infer<typeof namesWorkspaceResponseSchema>;
