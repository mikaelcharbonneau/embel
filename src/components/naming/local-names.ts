import { z } from "zod";
import { nameTransformInputSchema, nameValueSchema, transformNames, type NameTransformInput } from "@/domain/naming";
import { contextSnapshotSchema, type ContextSnapshot } from "@/domain/projects";
import { emptyGuidedUi, type GuidedResult } from "./guided-names";

export const NAMES_STORAGE_KEY = "fluid.names.v1";
import { MAX_NAMES, MAX_RUNS, MAX_NAMES_BYTES, namesWorkspaceSchema, namesUiSchema as uiSchema, createEmptyNamesWorkspace, readNamesBackup, type NamesWorkspace, type NameCandidate, type NamesForm, type NamesUi } from "@/domain/names-workspace";
export { MAX_NAMES, MAX_RUNS, MAX_NAMES_BYTES, namesWorkspaceSchema, createEmptyNamesWorkspace, readNamesBackup } from "@/domain/names-workspace";
export type { NamesWorkspace, NameCandidate, NameRun, NamesForm, NamesUi } from "@/domain/names-workspace";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const primarySeed = (input: NameTransformInput) => input.kind === "blend" ? input.left : input.seed;
const unique = (items: string[]) => new Set(items).size === items.length;

export type NamesMutationResult = { ok: boolean; persisted: boolean; error?: string };
export type NamesSnapshot = {
  loaded: boolean; data: NamesWorkspace; storage: "available" | "unavailable" | "invalid" | "conflict";
  dirty: boolean; error: string | null;
};
type StoragePort = Pick<Storage, "getItem" | "setItem">;

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

/** Deterministic Names editor. Legacy storage is used only for explicit backup recovery. */
export function createNamesStore(options: { storage: () => StoragePort | null; memoryOnly?: boolean; initialData?: NamesWorkspace; createId?: () => string; now?: () => string }) {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<() => void>();
  let snapshot: NamesSnapshot = Object.freeze({ loaded: false, data: freeze(options.initialData ? namesWorkspaceSchema.parse(options.initialData) : createEmptyNamesWorkspace()), storage: "available", dirty: false, error: null });
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
    if (options.memoryOnly) { publish({ ...snapshot, loaded: true }); return; }
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
  function persist(data: NamesWorkspace, replaceInvalid = false, uiOnly = false, preserveOnFailure = false): NamesMutationResult {
    let raw: string;
    try {
      if (uiOnly && data.candidates === snapshot.data.candidates && data.runs === snapshot.data.runs) {
        // These exact graphs are already validated and deeply frozen. Only internal UI actions
        // can take this path; every incoming storage payload and graph change is fully replayed.
        const ui = uiSchema.parse(data.ui);
        const ids = new Set(data.candidates.map(candidate => candidate.source.id));
        const invalidReferences = !unique(ui.comparisonIds) || ui.comparisonIds.some(id => !ids.has(id)) ||
          (ui.seedCandidateId !== null && !ids.has(ui.seedCandidateId)) ||
          (ui.activeRunId !== null && !data.runs.some(run => run.id === ui.activeRunId)) || !unique(ui.form.operations) ||
          ui.guided?.words.some(word => word.candidateId && data.candidates.find(candidate => candidate.source.id === word.candidateId)?.source.value !== word.value) ||
          ui.guided?.savedLists.some(list => list.words.some(word => word.candidateId && data.candidates.find(candidate => candidate.source.id === word.candidateId)?.source.value !== word.value));
        if (invalidReferences) return rejected("The selected name or run could not be found. Your workspace is unchanged.");
        const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(data.revision);
        data = { version: 1, revision, candidates: data.candidates, runs: data.runs, ui };
      } else data = namesWorkspaceSchema.parse(data);
      raw = JSON.stringify(data);
      if (byteLength(raw) > MAX_NAMES_BYTES) return rejected("This workspace has reached its 4 MB limit. Nothing was removed. Download a backup to keep a copy of your history.");
    } catch (error) { return rejected(validationMessage(error)); }
    if (options.memoryOnly) {
      publish({ loaded: true, data, storage: "available", dirty: true, error: null });
      return { ok: true, persisted: false };
    }
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
    if (error && preserveOnFailure) {
      if (storage === "unavailable") error = "The backup could not be saved. Your current workspace and previous saved data are unchanged.";
      publish({ ...snapshot, storage, error });
      return { ok: false, persisted: false, error };
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
    if (snapshot.data.candidates.length >= MAX_NAMES) return rejected("The 500-name limit has been reached. Nothing was removed. Download a backup to keep a copy of your history.");
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
    if (snapshot.data.runs.length >= MAX_RUNS) return rejected("The 100-run limit has been reached. Your full history is preserved. Download a backup to keep a copy of your history.");
    let parsed: NameTransformInput;
    try { parsed = input ? nameTransformInputSchema.parse(input) : formToNameInput(snapshot.data.ui.form); }
    catch (error) { return rejected(validationMessage(error)); }
    const output = transformNames(parsed);
    if (snapshot.data.candidates.length + output.candidates.length > MAX_NAMES) return rejected("This run would exceed the 500-name limit. No results or history were removed. Try a smaller run or download a backup to keep a copy of your history.");
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
  /** One atomic editor change: retain exact replayable steps and all intermediate lineage. */
  function retainGuidedResult(result: GuidedResult) {
    hydrate();
    const parent = snapshot.data.candidates.find(candidate => candidate.source.id === result.seed.candidateId);
    if (result.seed.candidateId && (!parent || parent.source.value !== result.seed.value)) return rejected("The source name changed. Choose it again before keeping this result.");
    try {
      const context = contextSnapshotSchema.parse(parent?.context ?? snapshot.data.ui.context);
      const inputs = result.inputs.map(input => nameTransformInputSchema.parse(input));
      let value = nameValueSchema.parse(result.seed.value);
      for (const input of inputs) {
        if (primarySeed(input) !== value) throw new Error("Invalid preview lineage");
        const output = transformNames(input).candidates;
        if (output.length !== 1) throw new Error("A preview step must produce exactly one result");
        value = output[0]!.value;
      }
      if (value !== result.value) throw new Error("Preview changed");
      const history = [...(parent?.source.history.map(step => step.input) ?? []), ...inputs];
      const existing = snapshot.data.candidates.find(candidate => candidate.source.value === value && equal(candidate.context, context) && equal(candidate.source.history.map(step => step.input), history) && (parent?.source.history.every((step, i) => equal(candidate.source.history[i], step)) ?? true));
      if (existing) return togglePreference(existing.source.id, "favorite");
      if (!inputs.length && parent) return togglePreference(parent.source.id, "favorite");
      const count = Math.max(inputs.length, 1);
      if (snapshot.data.candidates.length + count > MAX_NAMES || snapshot.data.runs.length + inputs.length > MAX_RUNS || history.length > 32) return rejected("Keeping this result would exceed the name, run or lineage limit. Nothing was removed. Download a backup to keep a copy of your history.");
      return mutate(data => {
        const candidates = [...data.candidates], runs = [...data.runs];
        let previous = parent;
        const createdAt = now();
        if (!inputs.length) candidates.push({ source: { id: createId(), value, origin: "manual", createdAt, history: [] }, context, runId: null, explanation: "Added manually", favorite: true, saved: false });
        for (const input of inputs) {
          const output = transformNames(input), generated = output.candidates[0]!, id = createId();
          const candidate: NameCandidate = { source: { id: createId(), value: generated.value, createdAt, origin: "workshop", history: [...structuredClone(previous?.source.history ?? []), { id, input, output: generated.value, createdAt }] }, context: structuredClone(context), runId: id, explanation: generated.explanation, favorite: false, saved: false };
          candidates.push(candidate); runs.push({ id, input, createdAt, parentId: previous?.source.id ?? null, candidateIds: [candidate.source.id], context: structuredClone(context), notes: output.notes, truncated: false }); previous = candidate;
        }
        if (inputs.length) candidates[candidates.length - 1] = { ...candidates.at(-1)!, favorite: true };
        return { ...data, candidates, runs };
      });
    } catch (error) { return rejected(validationMessage(error)); }
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
  function useGuidedWordList(id: string) {
    hydrate();
    const guided = snapshot.data.ui.guided ?? emptyGuidedUi();
    const list = guided.savedLists.find(item => item.id === id);
    if (!list) return rejected("That word list is no longer in this workspace.");
    return mutateUi(ui => ({ ...ui, tab: "workshop", context: structuredClone(list.context), guided: { ...guided, words: structuredClone(list.words), draft: "" } }));
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
    return mutateUi(ui => ({ ...ui, tab: "workshop", seedCandidateId: id, context: structuredClone(candidate.context), guided: { ...(ui.guided ?? emptyGuidedUi()), words: [{ value: candidate.source.value, candidateId: id }], draft: "" }, form: { ...ui.form, seed: candidate.source.value, left: candidate.source.value } }));
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
  function restoreBackup(raw: string, expectedWorkspace: NamesWorkspace): NamesMutationResult {
    hydrate();
    if (snapshot.storage !== "available" || snapshot.dirty) return rejected("Resolve browser storage recovery before restoring a backup. Your workspace is unchanged.");
    // A reset or loaded workspace can reuse a revision. Bind consent to the
    // exact immutable snapshot shown when the user selected the file.
    if (snapshot.data !== expectedWorkspace) return rejected("Your workspace changed after choosing this backup. Choose the file again before replacing it.");
    try {
      const restored = readNamesBackup(raw);
      return persist({ ...restored, revision: snapshot.data.revision + 1 }, false, false, true);
    } catch { return rejected("This is not a valid Embel Names backup. Its names and transformation history must be intact. Your workspace is unchanged."); }
  }
  function importBackup(raw: string, expectedWorkspace: NamesWorkspace): NamesMutationResult {
    hydrate();
    if (snapshot.data !== expectedWorkspace) return rejected("Your Names changed after choosing this backup. Review the backup again.");
    try {
      const incoming = readNamesBackup(raw);
      const candidates = new Map(snapshot.data.candidates.map(candidate => [candidate.source.id, candidate]));
      const runs = new Map(snapshot.data.runs.map(run => [run.id, run]));
      for (const candidate of incoming.candidates) {
        const previous = candidates.get(candidate.source.id);
        if (previous && !equal({ ...previous, favorite: false, saved: false }, { ...candidate, favorite: false, saved: false })) return rejected("A name in this backup conflicts with existing history. Nothing was imported.");
        candidates.set(candidate.source.id, previous ? { ...previous, favorite: previous.favorite || candidate.favorite, saved: previous.saved || candidate.saved } : candidate);
      }
      for (const run of incoming.runs) {
        const previous = runs.get(run.id);
        if (previous && !equal(previous, run)) return rejected("A run in this backup conflicts with existing history. Nothing was imported.");
        runs.set(run.id, run);
      }
      const currentGuided = snapshot.data.ui.guided ?? emptyGuidedUi();
      const lists = new Map(currentGuided.savedLists.map(list => [list.id, list]));
      for (const list of incoming.ui.guided?.savedLists ?? []) {
        if (lists.has(list.id) && !equal(lists.get(list.id), list)) return rejected("A saved word list conflicts with this backup. Nothing was imported.");
        lists.set(list.id, list);
      }
      // An empty account receives the complete workshop; otherwise import content
      // without replacing the account's current controls or captured context.
      const empty = !snapshot.data.candidates.length && !snapshot.data.runs.length && equal(snapshot.data.ui, createEmptyNamesWorkspace().ui);
      const ui = empty ? incoming.ui : { ...snapshot.data.ui, guided: { ...currentGuided, savedLists: [...lists.values()] } };
      return persist({ ...snapshot.data, candidates: [...candidates.values()], runs: [...runs.values()], ui, revision: snapshot.data.revision + 1 });
    } catch { return rejected("This backup could not be imported within the Names limits. Existing names and history are unchanged."); }
  }
  function readSavedRaw() {
    try { return getStorage().getItem(NAMES_STORAGE_KEY); } catch { return null; }
  }
  return {
    hydrate, getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onStorageChange, addManual, runWorkshop, retainGuidedResult, useGuidedWordList, updateUi, updateForm, updateContext, useAsSeed, togglePreference, toggleComparison,
    clearComparison: () => updateUi({ comparisonIds: [], compareOpen: false }), retrySave, replaceInvalid, loadSaved, startFresh, readSavedRaw, restoreBackup, importBackup,
  };
}

export type NamesStore = ReturnType<typeof createNamesStore>;
