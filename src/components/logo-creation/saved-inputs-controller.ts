import { logoBriefOutdated, logoSavedInputsSchema, type LogoSavedInputs } from "@/domain/logo-saved-inputs";
import type { LogoBriefDraft, LogoReferenceSelection, LogoStageRevision } from "@/domain/logo-workspace";
import type { LogoQuoteRequest } from "@/domain/logo-jobs";
import type { LogoDraftRecord } from "../identity/logo-draft-memory";
import { AccountRequestError, accountErrorMessage } from "../workspace/account-api";

export type LogoSavedInputPreparation =
  | { status: "obsolete" }
  | { status: "blocked"; message: string; source?: LogoSavedInputs }
  | { status: "prepared"; request: LogoQuoteRequest; source: LogoSavedInputs; used: "brand" | "current" }
  /** checkOnly: whether preparing would change the saved brief or liked images. */
  | { status: "checked"; source: LogoSavedInputs; outdated: boolean };

type Input = {
  ownerId: string;
  projectId: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  getDraft(): LogoDraftRecord | null;
  readSavedInputs(signal: AbortSignal): Promise<LogoSavedInputs | null>;
  saveBrief(brief: LogoBriefDraft): Promise<void>;
  saveReferences(selections: LogoReferenceSelection[]): Promise<void>;
  readBriefRevision(id: string, signal: AbortSignal): Promise<LogoStageRevision | null>;
  onProgress(phase: "reading" | "saving"): void;
  /** Compare only: report whether the saved likes are newer, and save nothing. */
  checkOnly?: boolean;
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const byReference = (rows: readonly LogoReferenceSelection[]) => [...rows].sort((a, b) => a.referenceId.localeCompare(b.referenceId));
export const logoDraftHasProtectedWork = (draft: LogoDraftRecord) => draft.dirty || draft.conflict || !!draft.vectorDraft || !!draft.directionDraft
  || !!draft.pendingCreation || !!draft.pendingMutation || !!draft.pendingIntent || !!draft.pendingExport;
const blockedEdits = "Your logo changes haven’t finished saving. They’re kept. Refresh logo inputs once they’re saved.";
const changed = "Your brand or logo brief changed. Refresh logo inputs to continue.";
const noName = "Choose and save a brand name in your project before generating logo concepts.";
const savedRevisionOf = (revision: LogoStageRevision | null, ref: { id: string; revision: number }, input: Input) =>
  revision && revision.stage === "brief_references" && revision.id === ref.id && revision.revision === ref.revision
  && revision.ownerId === input.ownerId && revision.projectId === input.projectId ? revision : null;

/** Prepares the saved inputs for new concepts: the latest brand and inspiration,
 * or a brief edited by hand since they last changed, and the liked uploaded
 * images as references. Logo types chosen in the brief are kept. This function
 * cannot admit a provider job. */
export async function prepareSavedLogoConcepts(input: Input): Promise<LogoSavedInputPreparation> {
  const current = () => !input.signal.aborted && input.isCurrent();
  const captured = input.getDraft();
  if (!current()) return { status: "obsolete" };
  if (!captured?.workspace || captured.workspace.ownerId !== input.ownerId || captured.workspace.projectId !== input.projectId)
    return { status: "blocked", message: "Your saved logo details could not be loaded. Try again." };
  if (logoDraftHasProtectedWork(captured)) return { status: "blocked", message: blockedEdits };
  const unchanged = () => current() && input.getDraft() === captured;
  let source: LogoSavedInputs | undefined;
  try {
    input.onProgress("reading");
    const raw = await input.readSavedInputs(input.signal);
    if (!current()) return { status: "obsolete" };
    if (!unchanged()) return { status: "blocked", message: blockedEdits };
    const parsed = logoSavedInputsSchema.safeParse(raw);
    if (!parsed.success || parsed.data.ownerId !== input.ownerId || parsed.data.projectId !== input.projectId) throw new AccountRequestError(502);
    source = parsed.data;
    if (source.projectRevision !== captured.workspace.heads.projectRevision) return { status: "blocked", message: changed, source };
    const briefRef = captured.workspace.stages.brief_references, currentBrief = briefRef ? captured.brief : null, draft = source.draft;
    let used: "brand" | "current" = draft ? "brand" : "current";
    if (draft && currentBrief && briefRef && !same(currentBrief, draft)) {
      const saved = savedRevisionOf(await input.readBriefRevision(briefRef.id, input.signal), briefRef, input);
      if (!current()) return { status: "obsolete" };
      if (!unchanged()) return { status: "blocked", message: blockedEdits, source };
      if (!saved) throw new AccountRequestError(502);
      if (!logoBriefOutdated(saved.payload, source)) used = "current";
    }
    const brief = used === "brand" && draft ? { ...draft, logoTypes: currentBrief?.logoTypes ?? draft.logoTypes } : currentBrief;
    if (!brief) return { status: "blocked", message: noName, source };
    const needsSave = !currentBrief || !same(currentBrief, brief);
    if (input.checkOnly) {
      const latest = input.getDraft();
      return { status: "checked", source, outdated: needsSave || !latest || !same(byReference(latest.references), byReference(source.references)) };
    }
    if (needsSave) {
      if (captured.workspace.capabilities.save.status !== "available") return {
        status: "blocked", source,
        message: "Your saved brand and inspiration are ready. Logo saving is unavailable. Check availability again to continue.",
      };
      if (!unchanged()) return { status: "blocked", message: blockedEdits, source };
      input.onProgress("saving");
      await input.saveBrief(brief);
      if (!current()) return { status: "obsolete" };
    }
    // Liked uploads guide the logo as whole-image references, replacing the
    // previous selection; the brief save above keeps whichever was saved.
    const references = byReference(source.references);
    const afterBrief = input.getDraft();
    const needsReferences = !afterBrief || !same(byReference(afterBrief.references), references);
    if (needsReferences) {
      if (!afterBrief?.workspace || afterBrief.workspace.capabilities.save.status !== "available") return {
        status: "blocked", source,
        message: "Your liked images are ready. Logo saving is unavailable. Check availability again to continue.",
      };
      if (logoDraftHasProtectedWork(afterBrief)) return { status: "blocked", message: blockedEdits, source };
      input.onProgress("saving");
      await input.saveReferences(references);
      if (!current()) return { status: "obsolete" };
    }
    const acknowledged = input.getDraft(), saves = Number(needsSave) + Number(needsReferences);
    if (!acknowledged?.workspace || acknowledged.workspace.ownerId !== input.ownerId || acknowledged.workspace.projectId !== input.projectId
      || acknowledged.workspace.heads.projectRevision !== source.projectRevision || logoDraftHasProtectedWork(acknowledged)
      || !same(acknowledged.brief, brief) || !same(byReference(acknowledged.references), references)
      || saves > 0 && acknowledged.workspace.heads.stageRevisions.brief_references !== captured.workspace.heads.stageRevisions.brief_references + saves)
      return { status: "blocked", source, message: "We couldn’t confirm your logo brief was saved. Check the save below before continuing." };
    const ref = acknowledged.workspace.stages.brief_references;
    if (!ref) return { status: "blocked", source, message: "Your logo brief could not be saved. Refresh logo inputs to try again." };
    const revision = savedRevisionOf(await input.readBriefRevision(ref.id, input.signal), ref, input);
    if (!current()) return { status: "obsolete" };
    if (input.getDraft() !== acknowledged) return { status: "blocked", message: blockedEdits, source };
    if (!revision) throw new AccountRequestError(502);
    const { name, activity, audience, personality, logoTypes } = revision.payload;
    if (!same({ name, activity, audience, personality, logoTypes }, brief)) throw new AccountRequestError(502);
    return { status: "prepared", source, used, request: { operation: "concepts", expected: acknowledged.workspace.heads,
      briefRevisionId: ref.id, referenceSnapshotId: revision.payload.referenceSnapshotId } };
  } catch (error) {
    if (!current()) return { status: "obsolete" };
    return { status: "blocked", ...(source ? { source } : {}), message: error instanceof AccountRequestError && error.status === 409
      ? changed : `${accountErrorMessage(error)} Your saved brand and earlier logo work are kept.` };
  }
}
