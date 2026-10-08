import { standaloneImportKey, standaloneImportSourceSchema, type StandaloneImportSource } from "@/domain/standalone-workspaces";
import { parseHandlesDraft } from "@/features/handles-workspace/account-codec";
import { handleSourceSchema, type HandleNameSource, type HandlesState } from "@/features/handles-workspace/domain";

/** Only invoke with an owner-checked envelope from the shared account client. */
export function handlesImportedName(input: StandaloneImportSource): HandleNameSource {
  const source = standaloneImportSourceSchema.parse(input);
  return handleSourceSchema.parse({ id: `account-name:${standaloneImportKey(source)}`, name: source.name,
    origin: source.origin === "naming_selection" ? "names" : "project", projectId: source.projectId, projectTitle: source.projectTitle });
}

/** Import adds a choice to the comparison, never a selected/reserved handle. */
export function importHandlesName(source: StandaloneImportSource, current: HandlesState): HandlesState {
  handlesImportedName(source);
  return parseHandlesDraft(current);
}

export function handlesAccountSourceLabel(source: HandleNameSource, imports: StandaloneImportSource[]): string {
  const parsed = handleSourceSchema.parse(source);
  const verified = imports.map(input => ({ input, source: handlesImportedName(input) })).find(item =>
    item.source.id === parsed.id && item.source.name === parsed.name && item.source.origin === parsed.origin &&
    item.source.projectId === parsed.projectId && item.source.projectTitle === parsed.projectTitle);
  return verified ? `Saved name import · ${verified.input.projectTitle} · revision ${verified.input.projectRevision}` : "User-entered source label";
}
