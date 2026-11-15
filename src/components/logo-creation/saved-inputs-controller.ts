import { logoBriefOutdated, logoSavedInputsSchema, type LogoSavedInputs } from "@/domain/logo-saved-inputs";
import type {
  LogoBriefDraft,
  LogoExpectedHeads,
  LogoReferenceSelection,
  LogoStageRevision,
} from "@/domain/logo-workspace";
import type { LogoRunRequest } from "@/domain/logo-jobs";
import type { LogoDraftRecord } from "../identity/logo-draft-memory";
import { AccountRequestError, accountErrorMessage } from "../workspace/account-api";

export type LogoSavedInputPreparation =
  | { status: "obsolete" }
  | { status: "blocked"; message: string; source?: LogoSavedInputs }
  | { status: "prepared"; request: LogoRunRequest; source: LogoSavedInputs; used: "brand" | "current" }
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
  /** Requests one liked upload's style note, as part of this deliberate generation. */
  requestStyleNote?(referenceId: string, expected: LogoExpectedHeads, signal: AbortSignal): Promise<void>;
  /** Requests every missing note at once (the generation engine writes them in one run). */
  requestStyleNotes?(referenceIds: readonly string[], signal: AbortSignal): Promise<void>;
  /** Waits between reads while requested notes are written. */
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>;
};
/** Notes usually take seconds; past this the concepts go ahead without the
 * unfinished ones, which join the next set once written. */
const STYLE_NOTE_WAIT_ROUNDS = 30,
  STYLE_NOTE_WAIT_MS = 2_000;

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const byReference = (rows: readonly LogoReferenceSelection[]) =>
  [...rows].sort((a, b) => a.referenceId.localeCompare(b.referenceId));
export const logoDraftHasProtectedWork = (draft: LogoDraftRecord) =>
  draft.dirty ||
  draft.conflict ||
  !!draft.vectorDraft ||
  !!draft.directionDraft ||
  !!draft.pendingMutation ||
  !!draft.pendingExport;
const blockedEdits = "Your logo changes haven’t finished saving. They’re kept. Refresh logo inputs once they’re saved.";
const changed = "Your brand or logo brief changed. Refresh logo inputs to continue.";
const noName = "Choose and save a brand name in your project before generating logo concepts.";
const savedRevisionOf = (revision: LogoStageRevision | null, ref: { id: string; revision: number }, input: Input) =>
  revision &&
  revision.stage === "brief_references" &&
  revision.id === ref.id &&
  revision.revision === ref.revision &&
  revision.ownerId === input.ownerId &&
  revision.projectId === input.projectId
    ? revision
    : null;

/** Prepares the saved inputs for new concepts: the latest brand and inspiration,
 * or a brief edited by hand since they last changed, and the liked uploaded
 * images as references. Logo types chosen in the brief are kept. This function
 * cannot admit a provider job. */
export async function prepareSavedLogoConcepts(input: Input): Promise<LogoSavedInputPreparation> {
  const current = () => !input.signal.aborted && input.isCurrent();
  const captured = input.getDraft();
  if (!current()) return { status: "obsolete" };
  if (
    !captured?.workspace ||
    captured.workspace.ownerId !== input.ownerId ||
    captured.workspace.projectId !== input.projectId
  )
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
    if (!parsed.success || parsed.data.ownerId !== input.ownerId || parsed.data.projectId !== input.projectId)
      throw new AccountRequestError(502);
    source = parsed.data;
    if (source.projectRevision !== captured.workspace.heads.projectRevision)
      return { status: "blocked", message: changed, source };
    // Liked uploads guide concepts through style notes: request the missing ones
    // once, then wait briefly for them. A note that is unavailable or still
    // being written stays out of this brief rather than holding the click.
    if (
      !input.checkOnly &&
      (input.requestStyleNote || input.requestStyleNotes) &&
      input.wait &&
      source.uploadNotes.some((note) => note.status === "missing" || note.status === "pending")
    ) {
      const awaited = new Set(
        source.uploadNotes.filter((row) => row.status === "pending").map((row) => row.referenceId),
      );
      const missing = source.uploadNotes.filter((row) => row.status === "missing").map((row) => row.referenceId);
      if (input.requestStyleNotes && missing.length) {
        try {
          await input.requestStyleNotes(missing, input.signal);
          for (const id of missing) awaited.add(id);
        } catch {
          if (!current()) return { status: "obsolete" };
        }
      } else if (input.requestStyleNote)
        for (const referenceId of missing) {
          try {
            await input.requestStyleNote(referenceId, captured.workspace.heads, input.signal);
            awaited.add(referenceId);
          } catch {
            if (!current()) return { status: "obsolete" };
          }
        }
      for (let round = 0; awaited.size && round < STYLE_NOTE_WAIT_ROUNDS; round += 1) {
        await input.wait(STYLE_NOTE_WAIT_MS, input.signal);
        if (!current()) return { status: "obsolete" };
        if (!unchanged()) return { status: "blocked", message: blockedEdits };
        const again = logoSavedInputsSchema.safeParse(await input.readSavedInputs(input.signal));
        if (!current()) return { status: "obsolete" };
        if (!again.success || again.data.ownerId !== input.ownerId || again.data.projectId !== input.projectId)
          throw new AccountRequestError(502);
        source = again.data;
        if (source.projectRevision !== captured.workspace.heads.projectRevision)
          return { status: "blocked", message: changed, source };
        if (
          !source.uploadNotes.some(
            (note) => awaited.has(note.referenceId) && (note.status === "pending" || note.status === "missing"),
          )
        )
          break;
      }
    }
    const briefRef = captured.workspace.stages.brief_references,
      currentBrief = briefRef ? captured.brief : null,
      draft = source.draft;
    let used: "brand" | "current" = draft ? "brand" : "current";
    if (draft && currentBrief && briefRef && !same(currentBrief, draft)) {
      const saved = savedRevisionOf(await input.readBriefRevision(briefRef.id, input.signal), briefRef, input);
      if (!current()) return { status: "obsolete" };
      if (!unchanged()) return { status: "blocked", message: blockedEdits, source };
      if (!saved) throw new AccountRequestError(502);
      if (!logoBriefOutdated(saved.payload, source)) used = "current";
    }
    const brief =
      used === "brand" && draft ? { ...draft, logoTypes: currentBrief?.logoTypes ?? draft.logoTypes } : currentBrief;
    if (!brief) return { status: "blocked", message: noName, source };
    const needsSave = !currentBrief || !same(currentBrief, brief);
    if (input.checkOnly) {
      const latest = input.getDraft();
      return {
        status: "checked",
        source,
        outdated: needsSave || !latest || !same(byReference(latest.references), byReference(source.references)),
      };
    }
    if (needsSave) {
      if (captured.workspace.capabilities.save.status !== "available")
        return {
          status: "blocked",
          source,
          message:
            "Your saved brand and inspiration are ready. Logo saving is unavailable. Check availability again to continue.",
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
      if (!afterBrief?.workspace || afterBrief.workspace.capabilities.save.status !== "available")
        return {
          status: "blocked",
          source,
          message: "Your liked images are ready. Logo saving is unavailable. Check availability again to continue.",
        };
      if (logoDraftHasProtectedWork(afterBrief)) return { status: "blocked", message: blockedEdits, source };
      input.onProgress("saving");
      await input.saveReferences(references);
      if (!current()) return { status: "obsolete" };
    }
    const acknowledged = input.getDraft(),
      saves = Number(needsSave) + Number(needsReferences);
    if (
      !acknowledged?.workspace ||
      acknowledged.workspace.ownerId !== input.ownerId ||
      acknowledged.workspace.projectId !== input.projectId ||
      acknowledged.workspace.heads.projectRevision !== source.projectRevision ||
      logoDraftHasProtectedWork(acknowledged) ||
      !same(acknowledged.brief, brief) ||
      !same(byReference(acknowledged.references), references) ||
      (saves > 0 &&
        acknowledged.workspace.heads.stageRevisions.brief_references !==
          captured.workspace.heads.stageRevisions.brief_references + saves)
    )
      return {
        status: "blocked",
        source,
        message: "We couldn’t confirm your logo brief was saved. Check the save below before continuing.",
      };
    const ref = acknowledged.workspace.stages.brief_references;
    if (!ref)
      return {
        status: "blocked",
        source,
        message: "Your logo brief could not be saved. Refresh logo inputs to try again.",
      };
    const revision = savedRevisionOf(await input.readBriefRevision(ref.id, input.signal), ref, input);
    if (!current()) return { status: "obsolete" };
    if (input.getDraft() !== acknowledged) return { status: "blocked", message: blockedEdits, source };
    if (!revision) throw new AccountRequestError(502);
    const { name, activity, audience, personality, logoTypes } = revision.payload;
    if (!same({ name, activity, audience, personality, logoTypes }, brief)) throw new AccountRequestError(502);
    return {
      status: "prepared",
      source,
      used,
      request: {
        operation: "concepts",
        expected: acknowledged.workspace.heads,
        briefRevisionId: ref.id,
        referenceSnapshotId: revision.payload.referenceSnapshotId,
      },
    };
  } catch (error) {
    if (!current()) return { status: "obsolete" };
    return {
      status: "blocked",
      ...(source ? { source } : {}),
      message:
        error instanceof AccountRequestError && error.status === 409
          ? changed
          : `${accountErrorMessage(error)} Your saved brand and earlier logo work are kept.`,
    };
  }
}

/* ── When preparation starts (docs/state-machines.md, S6) ─────────────────────────────────────────────
 * The Logo screen holds `LogoSavedInputState` (idle / reading / saving / prepared / blocked / checked /
 * obsolete) and three effects may start work on it. Each effect asks `savedInputsStart` with its own
 * trigger and does what the answer says, in a `setTimeout(0)`; the effects, their dependencies and that
 * timing stay in the screen. Two triggers can say "start" in the same render (new likes and new saved
 * heads): both timers are then set and the request itself admits one, because `prepareSavedInputs`
 * refuses while a read is already out (`savedInputsRead`) or a choice is being saved (`selecting`).
 * That refusal reads refs at the moment of the call, so it is not part of this decision. */

/** Every status the screen's saved-inputs state can hold. */
export type LogoSavedInputStatus = LogoSavedInputPreparation["status"] | "idle" | "reading" | "saving";

const savedInputsBusy = (status: LogoSavedInputStatus) => status === "reading" || status === "saving";

export type SavedInputsStartSituation =
  /** The Inspiration likes signal was read. Before the first concepts, new likes refresh the brief. */
  | {
      trigger: "likes_changed";
      /** The latest saved likes revision; null before Inspiration loads. */
      likes: string | null;
      /** The likes revision the screen last acted on or first saw. */
      seenLikes: string | null;
      conceptsExist: boolean;
      conceptsLoading: boolean;
      busy: boolean;
      status: LogoSavedInputStatus;
    }
  /** The saved workspace heads were read. Each set of heads is prepared once. */
  | {
      trigger: "saved_heads";
      /** The saved heads, as one string; null while nothing is saved. */
      headsKey: string | null;
      /** The heads last prepared, or last sent to be prepared. */
      preparedKey: string | null;
      /** The brief may be edited and nothing of it is unsaved, pending or in conflict. */
      canPrepare: boolean;
      conceptsExist: boolean;
      conceptsLoading: boolean;
      conceptsUnavailable: boolean;
      status: LogoSavedInputStatus;
    }
  /** Concepts exist, so the brief is left alone: only compare it with the saved likes. */
  | {
      trigger: "likes_check";
      /** The likes and heads to compare, as one string; null while there are no concepts or nothing saved. */
      checkKey: string | null;
      /** The key whose comparison has already answered. */
      checkedKey: string | null;
      busy: boolean;
    };

export type SavedInputsStartRefusal =
  /** Inspiration has not loaded, or its likes are the ones already seen. */
  | "likes_unchanged"
  /** The first likes reading on this screen: it is remembered, and nothing starts for it. */
  | "first_likes_reading"
  /** Concepts exist: changing the brief would send the chosen logo back for review. */
  | "concepts_exist"
  | "concepts_loading"
  | "concepts_unavailable"
  /** A read or a save of the inputs is under way. */
  | "busy"
  /** The state is one that preparation must not replace (for example a blocker, for new heads). */
  | "status_holds"
  | "nothing_saved"
  /** The brief has unsaved work, is being saved, is in conflict, or may not be edited now. */
  | "cannot_prepare"
  | "already_prepared"
  /** No concepts yet, or nothing saved: there is nothing to compare. */
  | "nothing_to_check"
  | "already_checked";

export type SavedInputsStartDecision =
  /** "refresh": reload the workspace, then prepare. "prepare": prepare. "check": compare only, save nothing. */
  { start: "refresh" | "prepare" | "check" } | { start: null; why: SavedInputsStartRefusal };

const refuse = (why: SavedInputsStartRefusal): SavedInputsStartDecision => ({ start: null, why });

/** Whether work on the saved inputs should start now, and why not otherwise. The order of the checks is
 * the order each effect had them in. */
export function savedInputsStart(situation: SavedInputsStartSituation): SavedInputsStartDecision {
  switch (situation.trigger) {
    case "likes_changed": {
      const { likes, seenLikes, status } = situation;
      if (likes === null || likes === seenLikes) return refuse("likes_unchanged");
      if (seenLikes === null) return refuse("first_likes_reading");
      if (situation.conceptsExist) return refuse("concepts_exist");
      if (situation.conceptsLoading) return refuse("concepts_loading");
      if (situation.busy) return refuse("busy");
      if (status !== "idle" && status !== "prepared" && status !== "blocked") return refuse("status_holds");
      return { start: "refresh" };
    }
    case "saved_heads": {
      const { headsKey, status } = situation;
      if (!headsKey) return refuse("nothing_saved");
      if (!situation.canPrepare) return refuse("cannot_prepare");
      if (situation.conceptsExist) return refuse("concepts_exist");
      if (situation.conceptsLoading) return refuse("concepts_loading");
      if (situation.conceptsUnavailable) return refuse("concepts_unavailable");
      if (savedInputsBusy(status)) return refuse("busy");
      if (status !== "idle" && status !== "prepared") return refuse("status_holds");
      if (situation.preparedKey === headsKey) return refuse("already_prepared");
      return { start: "prepare" };
    }
    case "likes_check":
      if (!situation.checkKey) return refuse("nothing_to_check");
      if (situation.checkedKey === situation.checkKey) return refuse("already_checked");
      if (situation.busy) return refuse("busy");
      return { start: "check" };
  }
}
