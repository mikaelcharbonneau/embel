import { z } from "zod";
import { nameTransformInputSchema, nameValueSchema, namingSourceSchema, transformNames, type NameTransformInput } from "@/domain/naming";
import { contextSnapshotSchema, type ContextSnapshot } from "@/domain/projects";

export const NAMES_STORAGE_KEY = "fluid.names.v1";
export const MAX_NAMES = 500;
export const MAX_RUNS = 100;
export const MAX_NAMES_BYTES = 4_000_000;

const kindSchema = z.enum(["affixes", "tweaks", "blend", "swap"]);
const operationSchema = z.enum(["lowercase", "uppercase", "titlecase", "remove_spaces", "hyphenate"]);
const formSchema = z.strictObject({
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
const uiSchema = z.strictObject({
  tab: z.enum(["library", "workshop", "assistant"]), filter: z.enum(["retained", "favorite", "saved", "all"]),
  origin: z.enum(["all", "manual", "workshop"]), query: z.string().max(160), manualValue: z.string().max(160),
  manualOpen: z.boolean(), compareOpen: z.boolean(), comparisonIds: z.array(z.uuid()).max(3),
  activeRunId: z.uuid().nullable(), seedCandidateId: z.uuid().nullable(), form: formSchema, context: workspaceContextSchema,
});

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const primarySeed = (input: NameTransformInput) => input.kind === "blend" ? input.left : input.seed;
const unique = (items: string[]) => new Set(items).size === items.length;

export const namesWorkspaceSchema = z.strictObject({
  version: z.literal(1), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  candidates: z.array(candidateSchema).max(MAX_NAMES), runs: z.array(runSchema).max(MAX_RUNS), ui: uiSchema,
}).superRefine((data, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const candidates = new Map(data.candidates.map(candidate => [candidate.source.id, candidate]));
  const runs = new Map(data.runs.map(run => [run.id, run]));
  if (candidates.size !== data.candidates.length || runs.size !== data.runs.length) fail("Duplicate identifiers");
  if (!unique(data.ui.comparisonIds) || data.ui.comparisonIds.some(id => !candidates.has(id))) fail("Invalid comparison selection");
  if (data.ui.activeRunId && !runs.has(data.ui.activeRunId)) fail("Missing selected run");
  if (data.ui.seedCandidateId && !candidates.has(data.ui.seedCandidateId)) fail("Missing seed candidate");
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
export type NameCandidate = NamesWorkspace["candidates"][number];
export type NameRun = NamesWorkspace["runs"][number];
export type NamesForm = z.infer<typeof formSchema>;
export type NamesUi = z.infer<typeof uiSchema>;
export type NamesMutationResult = { ok: boolean; persisted: boolean; error?: string };
export type NamesSnapshot = {
  loaded: boolean; data: NamesWorkspace; storage: "available" | "unavailable" | "invalid" | "conflict";
  dirty: boolean; error: string | null;
};
type StoragePort = Pick<Storage, "getItem" | "setItem">;

export function createEmptyNamesWorkspace(): NamesWorkspace {
  return {
    version: 1, revision: 0, candidates: [], runs: [],
    ui: {
      tab: "library", filter: "retained", origin: "all", query: "", manualValue: "", manualOpen: false,
      compareOpen: false, comparisonIds: [], activeRunId: null, seedCandidateId: null,
      context: contextSnapshotSchema.parse({}),
      form: { kind: "affixes", seed: "", prefixes: "", suffixes: "", separator: "", operations: ["lowercase"], left: "", right: "", leftTake: "1", rightDrop: "0", find: "", replacement: "", match: "all" },
    },
  };
}

export function formToNameInput(form: NamesForm): NameTransformInput {
  const list = (value: string) => value.split(/[\n,]/u).map(item => item.trim()).filter(Boolean);
  switch (form.kind) {
    case "affixes": return nameTransformInputSchema.parse({ kind: "affixes", seed: form.seed, prefixes: list(form.prefixes), suffixes: list(form.suffixes), separator: form.separator });
    case "tweaks": return nameTransformInputSchema.parse({ kind: "tweaks", seed: form.seed, operations: form.operations });
    case "blend": return nameTransformInputSchema.parse({ kind: "blend", left: form.left, right: form.right, leftTake: form.leftTake.trim() ? Number(form.leftTake) : NaN, rightDrop: form.rightDrop.trim() ? Number(form.rightDrop) : NaN });
    case "swap": return nameTransformInputSchema.parse({ kind: "swap", seed: form.seed, find: form.find, replacement: form.replacement, match: form.match });
  }
}

const validationMessage = (error: unknown) => error instanceof z.ZodError ? error.issues[0]?.message ?? "Check the form and try again." : "This change could not be recorded. Your existing names are unchanged.";
const byteLength = (raw: string) => new TextEncoder().encode(raw).byteLength;
const freeze = <T,>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

/** Browser-only data. No account identity, private project data, or provider calls enter this store. */
export function createNamesStore(options: { storage: () => StoragePort | null; createId?: () => string; now?: () => string }) {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<() => void>();
  let snapshot: NamesSnapshot = Object.freeze({ loaded: false, data: freeze(createEmptyNamesWorkspace()), storage: "available", dirty: false, error: null });
  let baseRaw: string | null | undefined;
  let protectedInvalidRaw: string | undefined;
  let hydrated = false;
  const emit = () => { for (const listener of listeners) listener(); };
  const publish = (next: NamesSnapshot) => { snapshot = Object.freeze({ ...next, data: freeze(next.data) }); emit(); };
  const getStorage = () => {
    const storage = options.storage();
    if (!storage) throw new Error("Storage is unavailable");
    return storage;
  };
  const parse = (raw: string | null) => {
    if (raw === null) return createEmptyNamesWorkspace();
    if (byteLength(raw) > MAX_NAMES_BYTES) throw new Error("Stored Names exceeds its size limit");
    return namesWorkspaceSchema.parse(JSON.parse(raw));
  };
  function hydrate() {
    if (hydrated) return;
    hydrated = true;
    let raw: string | null;
    try { raw = getStorage().getItem(NAMES_STORAGE_KEY); }
    catch { publish({ ...snapshot, loaded: true, storage: "unavailable", error: "Browser storage is unavailable. Changes stay in this tab until they can be saved." }); return; }
    baseRaw = raw;
    try { publish({ loaded: true, data: parse(raw), storage: "available", dirty: false, error: null }); }
    catch { protectedInvalidRaw = raw ?? undefined; publish({ ...snapshot, loaded: true, storage: "invalid", error: "Saved Names could not be read. The stored data has been left untouched." }); }
  }
  const rejected = (message: string): NamesMutationResult => {
    publish({ ...snapshot, error: message });
    return { ok: false, persisted: false, error: message };
  };
  function persist(data: NamesWorkspace, replaceInvalid = false, uiOnly = false): NamesMutationResult {
    let raw: string;
    try {
      if (uiOnly && data.candidates === snapshot.data.candidates && data.runs === snapshot.data.runs) {
        // These exact graphs are already validated and deeply frozen. Only internal UI actions
        // can take this path; every incoming storage payload and graph change is fully replayed.
        const ui = uiSchema.parse(data.ui);
        const ids = new Set(data.candidates.map(candidate => candidate.source.id));
        const invalidReferences = !unique(ui.comparisonIds) || ui.comparisonIds.some(id => !ids.has(id)) ||
          (ui.seedCandidateId !== null && !ids.has(ui.seedCandidateId)) ||
          (ui.activeRunId !== null && !data.runs.some(run => run.id === ui.activeRunId)) || !unique(ui.form.operations);
        if (invalidReferences) return rejected("The selected name or run could not be found. Your workspace is unchanged.");
        const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(data.revision);
        data = { version: 1, revision, candidates: data.candidates, runs: data.runs, ui };
      } else data = namesWorkspaceSchema.parse(data);
      raw = JSON.stringify(data);
      if (byteLength(raw) > MAX_NAMES_BYTES) return rejected("This workspace has reached its 4 MB limit. Nothing was removed. Download a copy before starting a new workspace.");
    } catch (error) { return rejected(validationMessage(error)); }
    let storage = snapshot.storage;
    let error: string | null = null;
    try {
      const port = getStorage();
      const currentRaw = port.getItem(NAMES_STORAGE_KEY);
      if (baseRaw === undefined) {
        // A denied initial read must never become permission to overwrite a previously saved workspace.
        if (currentRaw !== null) {
          parse(currentRaw);
          storage = "conflict";
          error = "A saved workspace was found. This tab's changes are separate; choose how to recover below.";
        } else baseRaw = null;
      } else if (currentRaw !== baseRaw) {
        try { parse(currentRaw); storage = "conflict"; error = "Names changed in another tab. This tab's changes are kept here; the saved version has not been overwritten."; }
        catch { protectedInvalidRaw = currentRaw ?? undefined; storage = "invalid"; error = "Saved Names changed and could not be read. This tab's changes and the stored data are both preserved."; }
      }
      if (!error && (snapshot.storage === "invalid" || snapshot.storage === "conflict") && !replaceInvalid) {
        storage = snapshot.storage;
        error = snapshot.storage === "invalid" ? "The unreadable saved data is protected. Use recovery below to save this workspace." : "Choose a saved version below before saving changes from this tab.";
      }
      if (!error) {
        port.setItem(NAMES_STORAGE_KEY, raw);
        baseRaw = raw;
        storage = "available";
      }
    } catch {
      storage = "unavailable";
      error = "This change is in this tab only. Browser storage is unavailable or full; your previous saved workspace is intact.";
    }
    publish({ loaded: true, data, storage, dirty: error !== null, error });
    return { ok: true, persisted: error === null, ...(error ? { error } : {}) };
  }
  function mutate(change: (data: NamesWorkspace) => NamesWorkspace): NamesMutationResult {
    hydrate();
    try { return persist({ ...change(structuredClone(snapshot.data)), revision: snapshot.data.revision + 1 }); }
    catch (error) { return rejected(validationMessage(error)); }
  }
  function mutateUi(change: (ui: NamesUi) => NamesUi): NamesMutationResult {
    hydrate();
    try { return persist({ ...snapshot.data, ui: change(structuredClone(snapshot.data.ui)), revision: snapshot.data.revision + 1 }, false, true); }
    catch (error) { return rejected(validationMessage(error)); }
  }
  function onStorageChange() {
    hydrate();
    let raw: string | null;
    try { raw = getStorage().getItem(NAMES_STORAGE_KEY); }
    catch { publish({ ...snapshot, storage: "unavailable", error: "Browser storage is unavailable. This tab's workspace is preserved." }); return; }
    if (raw === baseRaw) return;
    let data: NamesWorkspace;
    try { data = parse(raw); }
    catch { protectedInvalidRaw = raw ?? undefined; publish({ ...snapshot, storage: "invalid", error: "Saved Names changed and could not be read. This tab's workspace is preserved." }); return; }
    const incomingCandidates = new Map(data.candidates.map(candidate => [candidate.source.id, candidate]));
    const incomingRuns = new Map(data.runs.map(run => [run.id, run]));
    const immutableLoss = snapshot.data.candidates.some(candidate => {
      const incoming = incomingCandidates.get(candidate.source.id);
      return !incoming || !equal({ source: candidate.source, context: candidate.context, runId: candidate.runId, explanation: candidate.explanation }, { source: incoming.source, context: incoming.context, runId: incoming.runId, explanation: incoming.explanation });
    }) || snapshot.data.runs.some(run => !equal(run, incomingRuns.get(run.id)));
    // Compare-before-set cannot be atomic in localStorage. Preserve the losing tab's copy if two
    // writers raced at the same revision, or if an incoming version would remove immutable work.
    if (snapshot.dirty || immutableLoss || (data.revision <= snapshot.data.revision && !equal(data, snapshot.data))) {
      publish({ ...snapshot, dirty: true, storage: "conflict", error: "Names changed in another tab. This tab's work is preserved here; choose a recovery option below." });
      return;
    }
    baseRaw = raw;
    publish({ loaded: true, data, storage: "available", dirty: false, error: null });
  }
  function addManual(value?: string) {
    hydrate();
    if (snapshot.data.candidates.length >= MAX_NAMES) return rejected("The 500-name limit has been reached. Nothing was removed. Download a copy before starting a new workspace.");
    let parsed: string;
    try { parsed = nameValueSchema.parse(value ?? snapshot.data.ui.manualValue); }
    catch (error) { return rejected(validationMessage(error)); }
    return mutate(data => ({ ...data,
      candidates: [...data.candidates, { source: { id: createId(), value: parsed, createdAt: now(), origin: "manual", history: [] }, context: contextSnapshotSchema.parse(data.ui.context), runId: null, explanation: "Added manually", favorite: false, saved: true }],
      ui: { ...data.ui, manualValue: "", manualOpen: false, tab: "library", filter: "retained", query: "", origin: "all" },
    }));
  }
  function runWorkshop(input?: NameTransformInput) {
    hydrate();
    if (snapshot.data.runs.length >= MAX_RUNS) return rejected("The 100-run limit has been reached. Your full history is preserved. Download a copy before starting a new workspace.");
    let parsed: NameTransformInput;
    try { parsed = input ? nameTransformInputSchema.parse(input) : formToNameInput(snapshot.data.ui.form); }
    catch (error) { return rejected(validationMessage(error)); }
    const output = transformNames(parsed);
    if (snapshot.data.candidates.length + output.candidates.length > MAX_NAMES) return rejected("This run would exceed the 500-name limit. No results or history were removed. Try a smaller run or download a copy before starting a new workspace.");
    const parent = snapshot.data.candidates.find(candidate => candidate.source.id === snapshot.data.ui.seedCandidateId && candidate.source.value === primarySeed(parsed));
    if (parent && parent.source.history.length >= 32) return rejected("This seed already has 32 transformations. Its full history is preserved. Start from a new manual seed to continue.");
    return mutate(data => {
      const id = createId();
      const createdAt = now();
      const context = contextSnapshotSchema.parse(data.ui.context);
      const candidates: NameCandidate[] = output.candidates.map(candidate => ({
        source: { id: createId(), value: candidate.value, createdAt, origin: "workshop", history: [...structuredClone(parent?.source.history ?? []), { id, input: structuredClone(parsed), output: candidate.value, createdAt }] },
        context: structuredClone(context), runId: id, explanation: candidate.explanation, favorite: false, saved: false,
      }));
      return { ...data, candidates: [...data.candidates, ...candidates], runs: [...data.runs, { id, input: parsed, createdAt, parentId: parent?.source.id ?? null, candidateIds: candidates.map(candidate => candidate.source.id), context, notes: output.notes, truncated: output.truncated }], ui: { ...data.ui, activeRunId: id, tab: "workshop" } };
    });
  }
  function updateUi(patch: Partial<Omit<NamesUi, "form" | "context" | "seedCandidateId">>) {
    return mutateUi(ui => ({ ...ui, ...patch }));
  }
  function updateForm(patch: Partial<NamesForm>) {
    return mutateUi(ui => {
      const form = { ...ui.form, ...patch };
      if (patch.seed !== undefined) form.left = patch.seed;
      if (patch.left !== undefined) form.seed = patch.left;
      const parent = snapshot.data.candidates.find(candidate => candidate.source.id === ui.seedCandidateId);
      const primary = form.kind === "blend" ? form.left : form.seed;
      const seedCandidateId = parent && primary.normalize("NFC").trim() === parent.source.value ? parent.source.id : null;
      return { ...ui, form, seedCandidateId };
    });
  }
  function updateContext(patch: Partial<Pick<ContextSnapshot, "description" | "knownAudience">> & { namingNotes?: string }) {
    return mutateUi(ui => {
      const { namingNotes, ...fields } = patch;
      const sourceChanged = (["description", "knownAudience"] as const).some(key =>
        fields[key] !== undefined && fields[key].trim() !== ui.context[key].trim());
      const context = {
        ...ui.context, ...fields,
        ...(sourceChanged ? { reformulationConfirmed: false, competitorReviewComplete: false } : {}),
        intake: {
          ...ui.context.intake, ...(namingNotes === undefined ? {} : { namingNotes }),
          ...(sourceChanged ? { audienceReviewedAt: null, personalityReviewedAt: null, positioningReviewedAt: null } : {}),
        },
      };
      return { ...ui, context };
    });
  }
  function useAsSeed(id: string) {
    hydrate();
    const candidate = snapshot.data.candidates.find(item => item.source.id === id);
    if (!candidate) return rejected("That name is no longer in this workspace.");
    return mutateUi(ui => ({ ...ui, tab: "workshop", seedCandidateId: id, context: structuredClone(candidate.context), form: { ...ui.form, seed: candidate.source.value, left: candidate.source.value } }));
  }
  function togglePreference(id: string, preference: "favorite" | "saved") {
    hydrate();
    if (!snapshot.data.candidates.some(candidate => candidate.source.id === id)) return rejected("That name is no longer in this workspace.");
    return mutate(data => ({ ...data, candidates: data.candidates.map(candidate => candidate.source.id === id ? { ...candidate, [preference]: !candidate[preference] } : candidate) }));
  }
  function toggleComparison(id: string) {
    hydrate();
    if (!snapshot.data.candidates.some(candidate => candidate.source.id === id)) return rejected("That name is no longer in this workspace.");
    const selected = snapshot.data.ui.comparisonIds;
    if (!selected.includes(id) && selected.length >= 3) return rejected("Compare up to three names. Remove one from the tray to add another.");
    return updateUi({ comparisonIds: selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id] });
  }
  function retrySave() { hydrate(); return persist(snapshot.data); }
  function replaceInvalid() {
    hydrate();
    // Called only after an explicit recovery choice. A concurrent update still blocks replacement.
    let current: string | null;
    try { current = getStorage().getItem(NAMES_STORAGE_KEY); }
    catch { return rejected("Browser storage is still unavailable. Your current workspace stays in this tab."); }
    try { parse(current); }
    catch {
      if (current !== protectedInvalidRaw) {
        protectedInvalidRaw = current ?? undefined;
        return rejected("The unreadable stored data changed again. Download its current copy, then confirm recovery again.");
      }
      baseRaw = current;
      return persist(snapshot.data, true);
    }
    return rejected("The saved data is now readable. Load the saved version to review it before making changes.");
  }
  function loadSaved() {
    hydrate();
    let raw: string | null;
    let data: NamesWorkspace;
    try { raw = getStorage().getItem(NAMES_STORAGE_KEY); data = parse(raw); }
    catch { return rejected("The saved version could not be read. This tab's workspace is unchanged."); }
    baseRaw = raw;
    publish({ loaded: true, data, storage: "available", dirty: false, error: null });
    return { ok: true, persisted: true };
  }
  function startFresh() {
    hydrate();
    return persist(createEmptyNamesWorkspace());
  }
  function readSavedRaw() {
    try { return getStorage().getItem(NAMES_STORAGE_KEY); } catch { return null; }
  }
  return {
    hydrate, getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onStorageChange, addManual, runWorkshop, updateUi, updateForm, updateContext, useAsSeed, togglePreference, toggleComparison,
    clearComparison: () => updateUi({ comparisonIds: [], compareOpen: false }), retrySave, replaceInvalid, loadSaved, startFresh, readSavedRaw,
  };
}

export type NamesStore = ReturnType<typeof createNamesStore>;
