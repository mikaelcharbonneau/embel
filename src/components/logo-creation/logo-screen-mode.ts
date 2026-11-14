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
