import type { LogoRasterSource } from "@/domain/logo-workspace";

/**
 * The Logo screen's own modes (docs/state-machines.md, S2): what the person opened or asked for in
 * this tab, and which of its requests is still out. Saved data, typed text and what the engine
 * reports are not here; they stay with their hooks.
 */
export type LogoScreenMode = {
  /** The choice is being saved: nothing else may be chosen or edited until it answers. */
  choiceSaving: boolean;
  /** The concept being chosen right now: its card shows as chosen from the click, and goes back if saving fails. */
  choosing: LogoRasterSource | null;
  /** Which control was refused for lack of credits: the message appears there. */
  ranOut: "concepts" | "refine" | null;
  /** The logo types are open for a change while concepts exist. */
  changingTypes: boolean;
  /** "Discard local edits and reload" was pressed and waits for its confirmation. */
  confirmingDiscard: boolean;
  /** The original save of the brief or references is being checked. */
  checkingSave: boolean;
};

/*
 * Refs that stay refs. `logo-creation-workspace.tsx` keeps the flags below with `useRef`, and they are not
 * part of `LogoScreenMode` on purpose. Each is read in the same turn it is written, or after an `await`, or
 * by an effect that must not run again because of it. Held as state, the value read would be the one from
 * the last render, and writing it would render again and re-run the effects that list it. Do not move them
 * here; an earlier pass tried and stopped for these reasons.
 *
 * Locks, read at the moment of a call and written before its first `await`:
 * - `selecting` (boolean): one choice at a time. `selectCandidate` reads and sets it in one step, so a
 *   second click, or the automatic choice of a finished refinement (queued in a microtask), is refused
 *   before `choiceSaving` above has been rendered. `prepareSavedInputs` reads it too, so the brief is not
 *   rewritten under a choice. `selectCandidate` is memoized without it; as state it would change that
 *   function and re-run the effect that calls it.
 * - `savedInputsRead` (the request's AbortController, or null): one read or preparation of the saved
 *   inputs at a time. `prepareSavedInputs` and the read-only likes comparison read it inside
 *   `setTimeout(0)` callbacks. Two triggers can set a timer in the same render (`savedInputsStart` in
 *   `saved-inputs-controller.ts`); the second callback must see the lock the first one just took. It is
 *   released only by the request that holds it, and aborted when the screen goes away.
 * - `requestRead` (an AbortController, or null): the check of an unconfirmed save, or the choice, that is
 *   out. A second check and "Discard local edits" are refused while it is set. `finally` compares it with
 *   its own controller, so a request that ended late does not release a newer one; it is aborted when the
 *   screen goes away. `checkingSave` above only draws the same fact.
 *
 * Read by work already under way:
 * - `engineDrawing` (boolean): a concept round is running. The concept polling loop reads it after each
 *   read has answered, to decide whether to read again in three seconds, so it needs the value at that
 *   moment and not the one its effect started with. A layout effect writes it, which makes it right before
 *   the effects of the same commit run.
 *
 * Memories that make something happen once:
 * - `endedRound` (the running round's id, or null): when the round is no longer running, the saved
 *   concepts, their history and the workspace are read again, once. That effect also runs again whenever
 *   one of the things it calls changes; the ref is emptied first, so those runs do nothing. As state,
 *   emptying it would be one more render and one more run.
 * - `preparedInputsKey` (the saved heads last sent to be prepared): each set of heads is prepared once.
 *   It is written inside the effect's timer, and again with the new heads when a preparation has saved the
 *   brief, so the heads its own save produced are not prepared a second time. As state it would be a
 *   dependency of the effect that reads it: writing it would cancel that effect's timer and set another.
 * - `seenLikes` (the Inspiration likes revision last acted on): new likes refresh the brief once. It is
 *   written inside the effect that compares it, and is deliberately left unwritten while the refresh is
 *   held back, so the same likes are tried again when what held them changes.
 * - `selectedRefinementRequests` and `refreshedRefinementRequests` (sets of refinement request keys): a
 *   finished refinement is chosen automatically once, and the workspace is read again for it once, never
 *   in a loop. Both are read and written inside a queued microtask, between renders.
 *
 * (`refinementInput` is an ordinary ref to the text field, not a flag.)
 */

/** Named after what the person did or what arrived. */
export type LogoScreenEvent =
  /** A concept was clicked (`source`), or a check or retry of an unconfirmed choice was asked (`null`). */
  | { type: "choice_started"; source: LogoRasterSource | null }
  /** The choice's request ended. `current` is false when the account or project changed meanwhile. */
  | { type: "choice_ended"; current: boolean }
  /** A request for concepts or a change was sent. */
  | { type: "start_asked" }
  /** The server refused that request for lack of credits. */
  | { type: "credits_refused"; control: "concepts" | "refine" }
  | { type: "credits_message_dismissed" }
  | { type: "types_change_opened" }
  | { type: "types_change_done" }
  | { type: "discard_asked" }
  /** "Keep editing", or the discard was confirmed and the reload began. */
  | { type: "discard_answered" }
  | { type: "save_check_started" }
  | { type: "save_check_ended" };

export const LOGO_SCREEN_START: LogoScreenMode = {
  choiceSaving: false,
  choosing: null,
  ranOut: null,
  changingTypes: false,
  confirmingDiscard: false,
  checkingSave: false,
};

/** An event that changes nothing returns the same object, so the screen does not render again for it. */
function moved(mode: LogoScreenMode, change: Partial<LogoScreenMode>): LogoScreenMode {
  const keys = Object.keys(change) as (keyof LogoScreenMode)[];
  return keys.every((key) => Object.is(mode[key], change[key])) ? mode : { ...mode, ...change };
}

export function logoScreenReducer(mode: LogoScreenMode, event: LogoScreenEvent): LogoScreenMode {
  switch (event.type) {
    case "choice_started":
      return moved(mode, { choiceSaving: true, choosing: event.source });
    case "choice_ended":
      // The card goes back either way; a request that ended for another account leaves "saving" as it was.
      return moved(mode, { choosing: null, choiceSaving: event.current ? false : mode.choiceSaving });
    case "start_asked":
    case "credits_message_dismissed":
      return moved(mode, { ranOut: null });
    case "credits_refused":
      return moved(mode, { ranOut: event.control });
    case "types_change_opened":
      return moved(mode, { changingTypes: true });
    case "types_change_done":
      return moved(mode, { changingTypes: false });
    case "discard_asked":
      return moved(mode, { confirmingDiscard: true });
    case "discard_answered":
      return moved(mode, { confirmingDiscard: false });
    case "save_check_started":
      return moved(mode, { checkingSave: true });
    case "save_check_ended":
      return moved(mode, { checkingSave: false });
  }
}
