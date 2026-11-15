import type { GuidedReply, GuidedStage, GuidedTurn } from "@/domain/guided-interview";

/** Everything the conversation reads to decide its next move on its own (docs/state-machines.md, J5). */
export type GuidedTurnSituation = {
  /** The page is still on screen. */
  mounted: boolean;
  /** A save started by this page is under way. */
  locked: boolean;
  /** The project page is saving or loading. */
  busy: boolean;
  /** A request is being sent. */
  requestStarting: boolean;
  /** A request of this project is queued or running. */
  requestActive: boolean;
  /** This tab holds edits that are not saved. */
  dirty: boolean;
  conflict: boolean;
  /** The project's requests have been read. */
  overviewLoaded: boolean;
  /** Reading the project's requests failed. */
  readFailed: boolean;
  /** The conversation's saved stage; null when the project has no conversation yet. */
  stage: GuidedStage | "complete" | null;
  /** The saved project has a chosen name. */
  nameSelected: boolean;
  /** The conversation holds a slogan turn. */
  sloganTurnExists: boolean;
  /** The account may start a slogan request now. */
  sloganAllowed: boolean;
  /** Competitors, Audience, Positioning and Personality all have an answer. */
  strategyAnswered: boolean;
  /** The saved project's revision. */
  savedRevision: number;
  /** The latest turn, while it is the open question of the current stage. */
  currentTurn: GuidedTurn | null;
  /** The request made for the latest turn, and its reply once it has one. */
  bound: { jobId: string; reply: GuidedReply | null } | null;
  /** The account may start the current turn's request now. */
  requestAllowed: boolean;
};

/** Why the conversation does nothing now, in the order the checks are made. */
export type GuidedTurnIdleReason =
  | "unmounted"
  | "save_in_progress"
  | "page_busy"
  | "request_starting"
  | "request_active"
  | "unsaved_edits"
  | "conflict"
  | "no_open_turn"
  | "requests_not_read"
  | "requests_unreadable"
  | "turn_of_another_revision"
  | "request_already_made"
  | "request_not_allowed";

/** `key` names the attempt: the page makes each one once per mount, unless its save was not confirmed
 * (`guidedAttempts`). */
export type GuidedTurnAction =
  /** A name is chosen and no slogans were proposed yet: save the first slogan turn. */
  | { do: "start_slogan"; key: string }
  /** Embel read the message as a change of direction: reopen that stage and save its turn. */
  | { do: "redirect"; key: string; turn: GuidedTurn; reply: Extract<GuidedReply, { kind: "redirect" }> }
  /** Embel answered a question after Strategy was complete: mark the conversation complete again. */
  | { do: "finish_clarification"; key: string }
  /** Embel read the message as the answer to the open question: confirm it and save the next turn. */
  | { do: "accept"; key: string; turn: GuidedTurn; reply: Extract<GuidedReply, { kind: "accepted" }> }
  /** The open turn has no request yet: send it. */
  | { do: "enqueue"; key: string; turn: GuidedTurn }
  | { do: "nothing"; reason: GuidedTurnIdleReason };

const nothing = (reason: GuidedTurnIdleReason): GuidedTurnAction => ({ do: "nothing", reason });

/**
 * What the conversation does next without being asked. The order of the checks is the priority: the first
 * slogan turn, then a redirect, a clarification, an accepted answer, and last the open turn's request.
 *
 * Worth knowing:
 * - The slogan start is checked before the general guards and does not look at the open turn. When its own
 *   conditions hold but it was already attempted, nothing else is tried in that pass.
 * - An "answer" reply before the four Strategy answers exist, and a "choices" or "question" reply, end at
 *   "request_already_made": the person acts on them, the page does not.
 * - A reply the page would act on itself, for a turn of another revision, is not acted on: the page says the
 *   project changed (`guidedTurnStale`) and the person continues with a new message.
 * - Sending the request needs no lock here: the request hook refuses a second send while one is in flight,
 *   marks the page as working (`requestStarting`), and names the request after the project, revision and
 *   operation, so the same turn cannot be requested twice.
 */
export function guidedTurnAction(situation: GuidedTurnSituation): GuidedTurnAction {
  const { stage, savedRevision, currentTurn, bound } = situation;
  // Voice · Slogan opens once a name is chosen. Choosing the name is the
  // deliberate step; the proposal request keeps one identity per revision.
  if (
    situation.mounted &&
    !situation.locked &&
    !situation.busy &&
    !situation.requestStarting &&
    !situation.requestActive &&
    !situation.dirty &&
    !situation.conflict &&
    situation.overviewLoaded &&
    !situation.readFailed &&
    stage === "slogan" &&
    situation.nameSelected &&
    !situation.sloganTurnExists &&
    situation.sloganAllowed
  )
    return { do: "start_slogan", key: `slogan-start:${savedRevision}` };
  if (!situation.mounted) return nothing("unmounted");
  if (situation.locked) return nothing("save_in_progress");
  if (situation.busy) return nothing("page_busy");
  if (situation.requestStarting) return nothing("request_starting");
  if (situation.requestActive) return nothing("request_active");
  if (situation.dirty) return nothing("unsaved_edits");
  if (situation.conflict) return nothing("conflict");
  if (!currentTurn) return nothing("no_open_turn");
  if (!situation.overviewLoaded) return nothing("requests_not_read");
  if (situation.readFailed) return nothing("requests_unreadable");
  if (currentTurn.inputRevision !== savedRevision) return nothing("turn_of_another_revision");
  const reply = bound?.reply ?? null;
  if (bound && reply?.kind === "redirect")
    return { do: "redirect", key: `redirect:${bound.jobId}`, turn: currentTurn, reply };
  if (bound && reply?.kind === "answer" && situation.strategyAnswered)
    return { do: "finish_clarification", key: `clarification:${bound.jobId}` };
  if (bound && reply?.kind === "accepted")
    return { do: "accept", key: `accept:${bound.jobId}`, turn: currentTurn, reply };
  if (bound) return nothing("request_already_made");
  if (!situation.requestAllowed) return nothing("request_not_allowed");
  return { do: "enqueue", key: `request:${currentTurn.id}`, turn: currentTurn };
}

// ----- Has this been tried? -----

/** Which attempts the page has made since it was opened. An attempt is made once; when its save was not
 * confirmed it may be made again, but only after the situation has changed enough for the decision to
 * answer "nothing" in between (the failed save is on screen as unsaved, busy or in conflict). That keeps a
 * save that fails every time from being repeated in a loop. */
export function guidedAttempts() {
  const made = new Set<string>();
  const unconfirmed = new Set<string>();
  return {
    /** True when the page should run this action now; records it as made. */
    begin(action: GuidedTurnAction): action is Exclude<GuidedTurnAction, { do: "nothing" }> {
      if (action.do === "nothing") {
        for (const key of unconfirmed) made.delete(key);
        unconfirmed.clear();
        return false;
      }
      if (made.has(action.key)) return false;
      made.add(action.key);
      return true;
    },
    /** The person asked for this attempt themselves ("Retry request"). */
    record(key: string) {
      made.add(key);
    },
    /** The attempt's save did not come back confirmed. */
    saveNotConfirmed(key: string) {
      if (made.has(key)) unconfirmed.add(key);
    },
  };
}

// ----- Did the project move on under the open turn? -----

/** The open turn was saved for another revision of the project (a change in another tab, for example), so
 * the page will neither request its reply nor act on one that arrived. Replies the person acts on
 * themselves (choices, a question, an answer to read) stay usable and are not stale. */
export function guidedTurnStale({
  currentTurn,
  savedRevision,
  savePending,
  reply,
  strategyAnswered,
}: {
  currentTurn: Pick<GuidedTurn, "inputRevision"> | null;
  savedRevision: number;
  /** A conversation change is waiting to be confirmed as saved. */
  savePending: boolean;
  reply: Pick<GuidedReply, "kind"> | null;
  /** Competitors, Audience, Positioning and Personality all have an answer. */
  strategyAnswered: boolean;
}): boolean {
  if (!currentTurn || savePending || currentTurn.inputRevision === savedRevision) return false;
  return (
    !reply || reply.kind === "accepted" || reply.kind === "redirect" || (reply.kind === "answer" && strategyAnswered)
  );
}

// ----- Is a request running? -----

/** What the page asks about work under way. Each answer has one definition here; the page asks under these
 * names and nowhere works them out again. */
export type GuidedActivity = {
  /** Something is being saved, sent or worked on: the reply box and the brief are read-only. */
  pending: boolean;
  /** Nothing may be started: work is under way, or this tab has unsaved edits or a conflict. */
  blocked: boolean;
  /** The open turn's request is being saved or sent and is not confirmed yet. */
  turnStarting: boolean;
  /** Competitor research may be running, and its status is not known yet. */
  checkingResearch: boolean;
  /** Embel shows as working in the chat, with Stop in the reply box. */
  embelWorking: boolean;
  /** The work under way is competitor research (not a reply to a message). */
  researching: boolean;
};

export function guidedActivity({
  busy,
  working,
  requestStarting,
  requestActive,
  dirty,
  conflict,
  savePending,
  overviewLoaded,
  readFailed,
  currentTurn,
  turnRequested,
  turnJobRunning,
}: {
  /** The project page is saving or loading. */
  busy: boolean;
  /** A save started by the conversation is under way. */
  working: boolean;
  /** A request is being sent. */
  requestStarting: boolean;
  /** A request of this project is queued or running. */
  requestActive: boolean;
  dirty: boolean;
  conflict: boolean;
  /** A conversation change is waiting to be confirmed as saved. */
  savePending: boolean;
  overviewLoaded: boolean;
  readFailed: boolean;
  currentTurn: Pick<GuidedTurn, "stage" | "purpose"> | null;
  /** The open turn has a request. */
  turnRequested: boolean;
  /** The open turn's request is queued, running or being stopped. */
  turnJobRunning: boolean;
}): GuidedActivity {
  const pending = Boolean(busy || working || requestStarting || requestActive);
  const checkingResearch =
    currentTurn?.stage === "competitors" &&
    currentTurn.purpose !== "message" &&
    !readFailed &&
    (!overviewLoaded || (!turnRequested && requestStarting));
  return {
    pending,
    blocked: pending || dirty || conflict,
    turnStarting: Boolean(currentTurn && (requestStarting || busy || working || savePending)),
    checkingResearch,
    embelWorking: Boolean(requestActive || checkingResearch),
    researching:
      currentTurn?.stage === "competitors" &&
      currentTurn.purpose === "research" &&
      Boolean(turnJobRunning || (requestStarting && !turnRequested)),
  };
}
