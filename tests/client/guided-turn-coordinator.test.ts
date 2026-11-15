import { describe, expect, it } from "vitest";
import type { GuidedReply, GuidedTurn } from "@/domain/guided-interview";
import {
  guidedActivity,
  guidedAttempts,
  guidedTurnAction,
  guidedTurnStale,
  type GuidedTurnIdleReason,
  type GuidedTurnSituation,
} from "@/components/workspace/guided-turn-coordinator";

// What the project conversation does next on its own (docs/state-machines.md, J5).
const turn: GuidedTurn = {
  id: "turn-1",
  userMessageId: "message-1",
  stage: "audience",
  purpose: "propose",
  inputRevision: 4,
};
const replyFields = { turnId: turn.id, stage: "audience", message: "Here you go." };
const redirect = { ...replyFields, kind: "redirect", targetStage: "competitors" } as GuidedReply;
const answer = { ...replyFields, kind: "answer" } as GuidedReply;
const accepted = { ...replyFields, kind: "accepted", customText: "Parents" } as GuidedReply;
const choices = { ...replyFields, kind: "choices" } as GuidedReply;
const question = { ...replyFields, kind: "question" } as GuidedReply;
const bound = (reply: GuidedReply | null) => ({ jobId: "job-1", reply });

/** An open turn with no request yet, and nothing in the way of sending it. */
const ready: GuidedTurnSituation = {
  mounted: true,
  locked: false,
  busy: false,
  requestStarting: false,
  requestActive: false,
  dirty: false,
  conflict: false,
  overviewLoaded: true,
  readFailed: false,
  stage: "audience",
  nameSelected: false,
  sloganTurnExists: false,
  sloganAllowed: true,
  strategyAnswered: false,
  savedRevision: 4,
  currentTurn: turn,
  bound: null,
  requestAllowed: true,
};
/** A name is chosen on a conversation that has no slogan turn yet. */
const named: GuidedTurnSituation = { ...ready, stage: "slogan", nameSelected: true, currentTurn: null };
const idle = (situation: GuidedTurnSituation): GuidedTurnIdleReason | null => {
  const action = guidedTurnAction(situation);
  return action.do === "nothing" ? action.reason : null;
};

describe("what the conversation does next", () => {
  it("sends the open turn's request once, named after the turn", () => {
    expect(guidedTurnAction(ready)).toEqual({ do: "enqueue", key: "request:turn-1", turn });
  });

  it("does nothing while anything is in the way, and names the first thing that is", () => {
    const reasons: [Partial<GuidedTurnSituation>, GuidedTurnIdleReason][] = [
      [{ mounted: false }, "unmounted"],
      [{ locked: true }, "save_in_progress"],
      [{ busy: true }, "page_busy"],
      [{ requestStarting: true }, "request_starting"],
      [{ requestActive: true }, "request_active"],
      [{ dirty: true }, "unsaved_edits"],
      [{ conflict: true }, "conflict"],
      [{ currentTurn: null }, "no_open_turn"],
      [{ overviewLoaded: false }, "requests_not_read"],
      [{ readFailed: true }, "requests_unreadable"],
      [{ savedRevision: 5 }, "turn_of_another_revision"],
      [{ bound: bound(null) }, "request_already_made"],
      [{ requestAllowed: false }, "request_not_allowed"],
    ];
    for (const [change, reason] of reasons) expect(idle({ ...ready, ...change })).toBe(reason);
    // The order of the checks is the priority: each reason hides the ones after it.
    let situation = ready;
    for (const [change, reason] of [...reasons].reverse()) {
      situation = { ...situation, ...change };
      expect(idle(situation)).toBe(reason);
    }
  });

  it("follows a change of direction before anything else the reply could mean", () => {
    expect(guidedTurnAction({ ...ready, bound: bound(redirect), strategyAnswered: true })).toEqual({
      do: "redirect",
      key: "redirect:job-1",
      turn,
      reply: redirect,
    });
  });

  it("marks the conversation complete again after a clarification, only once Strategy is answered", () => {
    expect(guidedTurnAction({ ...ready, bound: bound(answer), strategyAnswered: true })).toEqual({
      do: "finish_clarification",
      key: "clarification:job-1",
    });
    expect(idle({ ...ready, bound: bound(answer) })).toBe("request_already_made");
  });

  it("confirms an accepted answer", () => {
    expect(guidedTurnAction({ ...ready, bound: bound(accepted), strategyAnswered: true })).toEqual({
      do: "accept",
      key: "accept:job-1",
      turn,
      reply: accepted,
    });
  });

  it("leaves choices and questions to the person", () => {
    for (const reply of [choices, question])
      expect(idle({ ...ready, bound: bound(reply) })).toBe("request_already_made");
  });

  it("acts on no reply while the turn belongs to another revision or something is in the way", () => {
    for (const reply of [redirect, accepted]) {
      expect(idle({ ...ready, bound: bound(reply), savedRevision: 5 })).toBe("turn_of_another_revision");
      expect(idle({ ...ready, bound: bound(reply), requestActive: true })).toBe("request_active");
      expect(idle({ ...ready, bound: bound(reply), dirty: true })).toBe("unsaved_edits");
    }
  });

  it("starts the first slogan turn once a name is chosen, one attempt per saved revision", () => {
    expect(guidedTurnAction(named)).toEqual({ do: "start_slogan", key: "slogan-start:4" });
    expect(guidedTurnAction({ ...named, savedRevision: 9 })).toMatchObject({ key: "slogan-start:9" });
    // It is checked first: an open turn and its reply do not matter.
    expect(guidedTurnAction({ ...named, currentTurn: turn, bound: bound(accepted) }).do).toBe("start_slogan");
  });

  it("does not start slogans without a name, twice, off the Slogan stage, or when not allowed", () => {
    expect(idle({ ...named, nameSelected: false })).toBe("no_open_turn");
    expect(idle({ ...named, sloganTurnExists: true })).toBe("no_open_turn");
    expect(idle({ ...named, stage: "complete" })).toBe("no_open_turn");
    expect(idle({ ...named, sloganAllowed: false })).toBe("no_open_turn");
    const blockers: [Partial<GuidedTurnSituation>, GuidedTurnIdleReason][] = [
      [{ mounted: false }, "unmounted"],
      [{ locked: true }, "save_in_progress"],
      [{ busy: true }, "page_busy"],
      [{ requestStarting: true }, "request_starting"],
      [{ requestActive: true }, "request_active"],
      [{ dirty: true }, "unsaved_edits"],
      [{ conflict: true }, "conflict"],
      [{ overviewLoaded: false }, "no_open_turn"],
      [{ readFailed: true }, "no_open_turn"],
    ];
    for (const [change, reason] of blockers) expect(idle({ ...named, ...change })).toBe(reason);
  });
});

describe("has this been tried?", () => {
  const accept = guidedTurnAction({ ...ready, bound: bound(accepted) });
  const failedSave = guidedTurnAction({ ...ready, bound: bound(accepted), dirty: true });

  it("makes each attempt once", () => {
    const attempts = guidedAttempts();
    expect(attempts.begin(accept)).toBe(true);
    expect(attempts.begin(accept)).toBe(false);
    expect(attempts.begin(guidedTurnAction(ready))).toBe(true);
    expect(attempts.begin(failedSave)).toBe(false);
    // A confirmed attempt stays made, whatever happens in between.
    expect(attempts.begin(accept)).toBe(false);
  });

  it("makes an attempt again after its save was not confirmed, once the failed save is settled", () => {
    const attempts = guidedAttempts();
    expect(attempts.begin(accept)).toBe(true);
    attempts.saveNotConfirmed("accept:job-1");
    // The failed save is on screen as unsaved edits: nothing is tried while it is.
    expect(attempts.begin(failedSave)).toBe(false);
    // "Retry save" or "Load latest version" settled it and the same step is still due.
    expect(attempts.begin(accept)).toBe(true);
    expect(attempts.begin(accept)).toBe(false);
  });

  it("does not repeat a save that fails without leaving anything to settle", () => {
    const attempts = guidedAttempts();
    expect(attempts.begin(accept)).toBe(true);
    attempts.saveNotConfirmed("accept:job-1");
    for (let pass = 0; pass < 3; pass += 1) expect(attempts.begin(accept)).toBe(false);
  });

  it("counts a request the person retried themselves as made", () => {
    const attempts = guidedAttempts();
    attempts.record("request:turn-1");
    expect(attempts.begin(guidedTurnAction(ready))).toBe(false);
  });
});

describe("did the project move on under the open turn?", () => {
  const moved = { currentTurn: turn, savedRevision: 5, savePending: false, reply: null, strategyAnswered: false };

  it("is stale when the turn was saved for another revision and has no reply", () => {
    expect(guidedTurnStale(moved)).toBe(true);
    expect(guidedTurnStale({ ...moved, savedRevision: 4 })).toBe(false);
    expect(guidedTurnStale({ ...moved, savePending: true })).toBe(false);
    expect(guidedTurnStale({ ...moved, currentTurn: null })).toBe(false);
  });

  it("is stale for exactly the replies the page would have acted on itself and now will not", () => {
    for (const [reply, strategyAnswered] of [
      [accepted, false],
      [redirect, false],
      [answer, true],
    ] as const) {
      expect(idle({ ...ready, bound: bound(reply), strategyAnswered, savedRevision: 5 })).toBe(
        "turn_of_another_revision",
      );
      expect(guidedTurnStale({ ...moved, reply, strategyAnswered })).toBe(true);
      expect(guidedTurnStale({ ...moved, reply, strategyAnswered, savedRevision: 4 })).toBe(false);
    }
  });

  it("leaves replies the person acts on usable", () => {
    for (const reply of [choices, question, answer]) expect(guidedTurnStale({ ...moved, reply })).toBe(false);
  });
});

describe("is a request running?", () => {
  const quiet = {
    busy: false,
    working: false,
    requestStarting: false,
    requestActive: false,
    dirty: false,
    conflict: false,
    savePending: false,
    overviewLoaded: true,
    readFailed: false,
    currentTurn: null,
    turnRequested: false,
    turnJobRunning: false,
  };
  const research = { stage: "competitors", purpose: "research" } as const;
  const nothing = {
    pending: false,
    blocked: false,
    turnStarting: false,
    checkingResearch: false,
    embelWorking: false,
    researching: false,
  };

  it("answers no to everything when nothing is under way", () => {
    expect(guidedActivity(quiet)).toEqual(nothing);
    expect(guidedActivity({ ...quiet, currentTurn: research })).toEqual(nothing);
  });

  it("is pending for a save, a request being sent or a request at work, and blocked also by unsaved edits", () => {
    for (const change of [{ busy: true }, { working: true }, { requestStarting: true }, { requestActive: true }])
      expect(guidedActivity({ ...quiet, ...change })).toMatchObject({ pending: true, blocked: true });
    for (const change of [{ dirty: true }, { conflict: true }])
      expect(guidedActivity({ ...quiet, ...change })).toMatchObject({ pending: false, blocked: true });
    // A change waiting to be confirmed as saved is neither.
    expect(guidedActivity({ ...quiet, savePending: true })).toEqual(nothing);
  });

  it("says the turn is starting only with an open turn, and not for a request already at work", () => {
    for (const change of [{ busy: true }, { working: true }, { requestStarting: true }, { savePending: true }]) {
      expect(guidedActivity({ ...quiet, ...change }).turnStarting).toBe(false);
      expect(guidedActivity({ ...quiet, ...change, currentTurn: research }).turnStarting).toBe(true);
    }
    expect(guidedActivity({ ...quiet, requestActive: true, currentTurn: research }).turnStarting).toBe(false);
  });

  it("checks research status for a competitor turn that is not a message, until its request is known", () => {
    const unread = { ...quiet, overviewLoaded: false, currentTurn: research };
    expect(guidedActivity(unread)).toMatchObject({ checkingResearch: true, embelWorking: true, pending: false });
    expect(
      guidedActivity({ ...unread, currentTurn: { stage: "competitors", purpose: "propose" } }).checkingResearch,
    ).toBe(true);
    expect(guidedActivity({ ...unread, readFailed: true }).checkingResearch).toBe(false);
    expect(
      guidedActivity({ ...unread, currentTurn: { stage: "competitors", purpose: "message" } }).checkingResearch,
    ).toBe(false);
    expect(guidedActivity({ ...unread, currentTurn: { stage: "audience", purpose: "propose" } }).checkingResearch).toBe(
      false,
    );
    const sending = { ...quiet, requestStarting: true, currentTurn: research };
    expect(guidedActivity(sending).checkingResearch).toBe(true);
    expect(guidedActivity({ ...sending, turnRequested: true }).checkingResearch).toBe(false);
  });

  it("shows Embel working for any request at work in the project", () => {
    expect(guidedActivity({ ...quiet, requestActive: true }).embelWorking).toBe(true);
    expect(guidedActivity({ ...quiet, requestStarting: true }).embelWorking).toBe(false);
    expect(guidedActivity({ ...quiet, working: true }).embelWorking).toBe(false);
  });

  it("calls it research only for a competitor research turn that runs or is being sent", () => {
    const running = { ...quiet, currentTurn: research, turnRequested: true, turnJobRunning: true };
    expect(guidedActivity(running).researching).toBe(true);
    expect(guidedActivity({ ...quiet, currentTurn: research, requestStarting: true }).researching).toBe(true);
    expect(guidedActivity({ ...running, turnJobRunning: false, requestStarting: true }).researching).toBe(false);
    expect(guidedActivity({ ...running, currentTurn: { stage: "competitors", purpose: "propose" } }).researching).toBe(
      false,
    );
    expect(guidedActivity({ ...running, currentTurn: { stage: "audience", purpose: "research" } }).researching).toBe(
      false,
    );
  });
});
