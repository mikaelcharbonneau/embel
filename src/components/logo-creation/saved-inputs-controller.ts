import { logoSavedInputsSchema, type LogoSavedInputs } from "@/domain/logo-saved-inputs";
import type { LogoBriefDraft, LogoExpectedHeads, LogoStageRevision } from "@/domain/logo-workspace";
import type { LogoQuoteRequest } from "@/domain/logo-jobs";
import type { LogoDraftRecord } from "../identity/logo-draft-memory";
import { AccountRequestError, accountErrorMessage } from "../workspace/account-api";

export type LogoSavedInputReview = {
  source: LogoSavedInputs;
  expected: LogoExpectedHeads;
  currentBrief: LogoBriefDraft | null;
};
export type LogoSavedInputChoice = { review: LogoSavedInputReview; use: "brand" | "current" };
export type LogoSavedInputPreparation =
  | { status: "obsolete" }
  | { status: "blocked"; message: string; source?: LogoSavedInputs }
  | { status: "review"; review: LogoSavedInputReview }
  | { status: "prepared"; request: LogoQuoteRequest; source: LogoSavedInputs; used: "brand" | "current" };

type Input = {
  ownerId: string;
  projectId: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  getDraft(): LogoDraftRecord | null;
  readSavedInputs(signal: AbortSignal): Promise<LogoSavedInputs | null>;
  saveBrief(brief: LogoBriefDraft): Promise<void>;
  readBriefRevision(id: string, signal: AbortSignal): Promise<LogoStageRevision | null>;
  onProgress(phase: "reading" | "saving"): void;
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const logoDraftHasProtectedWork = (draft: LogoDraftRecord) => draft.dirty || draft.conflict || !!draft.vectorDraft || !!draft.directionDraft
  || !!draft.pendingCreation || !!draft.pendingMutation || !!draft.pendingIntent || !!draft.pendingExport;
const blockedEdits = "Save or undo your changes in Logo brief and history first. Your changes are kept.";
const changed = "Your brand or logo brief changed. Refresh your saved brand in Logo brief and history, then try again.";

/** Prepares unambiguous saved inputs before quoting. Conflicting inputs still
 * require an explicit choice; this function cannot admit a provider job. */
export async function prepareSavedLogoConcepts(input: Input, choice?: LogoSavedInputChoice): Promise<LogoSavedInputPreparation> {
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
    const currentBrief = captured.workspace.stages.brief_references ? captured.brief : null;
    const review: LogoSavedInputReview = { source, expected: captured.workspace.heads, currentBrief };
    const acceptedChoice = choice && same(choice.review, review) ? choice.use : null;
    if (!source.draft && !currentBrief)
      return { status: "blocked", message: "Choose and save a brand name in your project before generating logo concepts.", source };
    if ((source.nameConflict || currentBrief && !same(currentBrief, source.draft) || choice && !acceptedChoice) && !acceptedChoice)
      return { status: "review", review };
    const used = acceptedChoice ?? "brand";
    const brief = used === "current" ? currentBrief : source.draft;
    if (!brief) return { status: "blocked", message: "Choose and save a brand name in your project before generating logo concepts.", source };
    const needsSave = !currentBrief || !same(currentBrief, brief);
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
    const acknowledged = input.getDraft();
    if (!acknowledged?.workspace || acknowledged.workspace.ownerId !== input.ownerId || acknowledged.workspace.projectId !== input.projectId
      || acknowledged.workspace.heads.projectRevision !== source.projectRevision || logoDraftHasProtectedWork(acknowledged)
      || !same(acknowledged.brief, brief) || needsSave && acknowledged.workspace.heads.stageRevisions.brief_references !== captured.workspace.heads.stageRevisions.brief_references + 1)
      return { status: "blocked", source, message: "We couldn’t confirm your logo brief was saved. Open Logo brief and history to check it before continuing." };
    const ref = acknowledged.workspace.stages.brief_references;
    if (!ref) return { status: "blocked", source, message: "Your logo brief could not be saved. Check Logo brief and history and try again." };
    const revision = await input.readBriefRevision(ref.id, input.signal);
    if (!current()) return { status: "obsolete" };
    if (input.getDraft() !== acknowledged) return { status: "blocked", message: blockedEdits, source };
    if (!revision || revision.stage !== "brief_references" || revision.id !== ref.id || revision.revision !== ref.revision
      || revision.ownerId !== input.ownerId || revision.projectId !== input.projectId) throw new AccountRequestError(502);
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
