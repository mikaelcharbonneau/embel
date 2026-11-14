/** "Saving, then opening the project" as `useAccountStrategyStart` shows it (docs/state-machines.md, J7).
 *
 * Known duplication, kept on purpose: the Home form holds its own `opening` (`home-start-form-state.ts`)
 * for a brief saved with files, which never goes through this hook; this one serves a typed prompt. The
 * hook also keeps a `destination` ref with the same value as `destination` here: the ref answers a second
 * request synchronously, before this state is rendered. Merging any of the three would change timing. */
export type HomeStartOpeningState = {
  /** What the notice says, and whether a save or start is in flight, for one account session. */
  action: { identity: string; pending: boolean; message: string } | null;
  /** The account session whose save replaces the form with the opening view while it is pending. */
  opening: string | null;
  /** The project being opened. */
  destination: { identity: string; href: string } | null;
};

export type HomeStartOpeningEvent =
  /** The person asked to check AI availability. */
  | { type: "availability_check_started"; identity: string; message: string }
  /** The check answered, or could not be confirmed. */
  | { type: "availability_check_finished"; identity: string; message: string }
  /** A save or start was sent. `showOpening` is false for a plain save outside the guided Home. */
  | { type: "save_started"; identity: string; showOpening: boolean }
  /** The project is saved and the router was asked to open it. */
  | { type: "project_opening"; identity: string; href: string }
  /** The router refused. Only the destination is dropped; the save's own ending follows. */
  | { type: "project_open_failed" }
  /** The save could not be confirmed. */
  | { type: "save_failed"; identity: string; message: string }
  /** The save ended without a project being opened. */
  | { type: "save_settled"; identity: string }
  /** The person started a new prompt. */
  | { type: "prompt_detached" };

export const initialHomeStartOpening: HomeStartOpeningState = { action: null, opening: null, destination: null };

export function homeStartOpeningReducer(
  state: HomeStartOpeningState,
  event: HomeStartOpeningEvent,
): HomeStartOpeningState {
  switch (event.type) {
    case "availability_check_started":
    case "availability_check_finished":
    case "save_failed":
      return { ...state, action: { identity: event.identity, pending: false, message: event.message } };
    case "save_started":
      return {
        ...state,
        opening: event.showOpening ? event.identity : state.opening,
        action: { identity: event.identity, pending: true, message: "Saving your project…" },
      };
    case "project_opening":
      return {
        destination: { identity: event.identity, href: event.href },
        opening: event.identity,
        action: { identity: event.identity, pending: true, message: "Project saved. Opening your project…" },
      };
    case "project_open_failed":
      return state.destination ? { ...state, destination: null } : state;
    case "save_settled":
      // A notice that belongs to another account session is left alone.
      return {
        ...state,
        opening: null,
        action: state.action?.identity === event.identity ? { ...state.action, pending: false } : state.action,
      };
    case "prompt_detached":
      return state.action || state.opening ? { ...state, action: null, opening: null } : state;
  }
}
