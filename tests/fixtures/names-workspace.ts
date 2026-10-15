import { createEmptyNamesWorkspace, type NamesWorkspace } from "../../src/domain/names-workspace";
import { emptyGuidedUi } from "../../src/domain/names-guided";
import { transformNames, type NameTransformInput } from "../../src/domain/naming";

export const namesFixtureId = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
export const namesFixtureTime = "2026-10-15T12:34:56.123456Z";

/** Synthetic local data, including the complete legacy graph and editable controls. */
export function namesWorkspaceFixture(): NamesWorkspace {
  const data = createEmptyNamesWorkspace();
  data.revision = 42;
  const context = { ...data.ui.context, description: "A local fixture for forest products", knownAudience: "Outdoor teams" };
  const manual = { source: { id: namesFixtureId(1), value: "Cedar", createdAt: namesFixtureTime, origin: "manual" as const, history: [] },
    context, runId: null, explanation: "Added manually", favorite: false, saved: true };
  data.candidates.push(manual);
  const addRun = (input: NameTransformInput, parent: NamesWorkspace["candidates"][number], index: number) => {
    const output = transformNames(input), id = namesFixtureId(100 + index);
    const candidates = output.candidates.map((result, i) => ({
      source: { id: namesFixtureId(index * 10 + i), value: result.value, createdAt: namesFixtureTime, origin: "workshop" as const,
        history: [...parent.source.history, { id, input, output: result.value, createdAt: namesFixtureTime }] },
      context, runId: id, explanation: result.explanation, favorite: true, saved: false,
    }));
    data.runs.push({ id, input, createdAt: namesFixtureTime, parentId: parent.source.id,
      candidateIds: candidates.map(candidate => candidate.source.id), context, notes: output.notes, truncated: output.truncated });
    data.candidates.push(...candidates);
    return candidates[0]!;
  };
  const first = addRun({ kind: "affixes", seed: "Cedar", prefixes: ["Neo"], suffixes: ["Works"], separator: "" }, manual, 1);
  const last = addRun({ kind: "tweaks", seed: first.source.value, operations: ["uppercase"] }, first, 2);
  data.ui = { ...data.ui, tab: "history", filter: "all", query: "cedar", manualOpen: true, compareOpen: true,
    comparisonIds: [manual.source.id, last.source.id], activeRunId: data.runs[1]!.id, seedCandidateId: last.source.id,
    context: { ...context, description: "  An unfinished description  " },
    form: { ...data.ui.form, kind: "blend", left: last.source.value, right: "Moss", leftTake: "4", rightDrop: "1" },
    guided: { ...emptyGuidedUi(), words: [{ value: last.source.value, candidateId: last.source.id }], draft: "  Next word  ",
      prefixes: ["New"], customSuffixes: ["Lab"], tweaks: ["reverse"],
      savedLists: [{ id: namesFixtureId(300), words: [{ value: "Cedar", candidateId: manual.source.id }], context, createdAt: namesFixtureTime }] },
  };
  return data;
}
