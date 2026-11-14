/** The Home prompt form's mode (docs/state-machines.md, J7). The typed text, the message shown under
 * it and the file-storage answer are not here: they are content, not mode. */
export type HomeStartFormState = {
  /** The prompt kept for sign-in has been looked for. Nothing may be edited or sent before. */
  recoveryLoaded: boolean;
  /** The prompt shown was restored from an earlier visit. */
  resumedPrompt: boolean;
  /** The restored prompt is tied to an earlier account save. */
  recoveryLocked: boolean;
  /** The copy of the prompt kept on this device. */
  textDraftId: string | null;
  /** The account the prompt belongs to; `null` when it belongs to nobody yet. */
  promptOwner: string | null;
  /** The text came from an example. */
  exampleUsed: boolean;
  /** A send is under way. The form also keeps a synchronous guard, which a second click in the same
   * turn reads before this value is rendered. */
  submitting: boolean;
  /** A saved attached brief is being opened, for the account session named by `fence`. The typed-prompt
   * path keeps its own copy in `home-start-opening.ts`; see the note there. */
  opening: { fence: string; href: string } | null;
};

export type HomeStartFormEvent =
  /** The browser was read for a prompt kept before sign-in. */
  | { type: "recovery_checked" }
  /** A kept prompt was found and put back. */
  | { type: "prompt_restored"; draftId: string; locked: boolean; ownerId: string | null; example: boolean }
  /** The person typed in the prompt field. */
  | { type: "prompt_edited"; ownerId: string | null }
  /** The person picked an example. The owner is left as it was. */
  | { type: "example_chosen" }
  /** A new copy of the prompt was kept on this device. */
  | { type: "draft_kept"; draftId: string; ownerId: string | null }
  /** An existing copy was kept again by the signed-in account. */
  | { type: "prompt_claimed"; ownerId: string }
  /** "Start a new prompt" on the restored-prompt notice. Leaves `recoveryLocked` as it is. */
  | { type: "new_prompt_started" }
  /** "Start a new prompt" on the notice for a prompt that belongs to another account. Also unlocks. */
  | { type: "other_account_prompt_set_aside" }
  | { type: "send_started" }
  | { type: "send_finished" }
  /** An attached brief was saved and its project is being opened. */
  | { type: "project_opening"; fence: string; href: string }
  /** The router refused to open it. */
  | { type: "project_open_failed" };

export function initialHomeStartForm(exampleUsed: boolean): HomeStartFormState {
  return {
    recoveryLoaded: false,
    resumedPrompt: false,
    recoveryLocked: false,
    textDraftId: null,
    promptOwner: null,
    exampleUsed,
    submitting: false,
    opening: null,
  };
}

/** Returns the same object when nothing changes, so an event that changes nothing renders nothing. */
function change(state: HomeStartFormState, patch: Partial<HomeStartFormState>): HomeStartFormState {
  const keys = Object.keys(patch) as (keyof HomeStartFormState)[];
  return keys.every((key) => Object.is(state[key], patch[key])) ? state : { ...state, ...patch };
}

export function homeStartFormReducer(state: HomeStartFormState, event: HomeStartFormEvent): HomeStartFormState {
  switch (event.type) {
    case "recovery_checked":
      return change(state, { recoveryLoaded: true });
    case "prompt_restored":
      return change(state, {
        textDraftId: event.draftId,
        recoveryLocked: event.locked,
        promptOwner: event.ownerId,
        exampleUsed: event.example,
        resumedPrompt: true,
      });
    case "prompt_edited":
      return change(state, { promptOwner: event.ownerId });
    case "example_chosen":
      return change(state, { exampleUsed: true });
    case "draft_kept":
      return change(state, { textDraftId: event.draftId, promptOwner: event.ownerId });
    case "prompt_claimed":
      return change(state, { promptOwner: event.ownerId });
    // The two "Start a new prompt" buttons reset different things today. Kept apart on purpose.
    case "new_prompt_started":
      return change(state, { textDraftId: null, promptOwner: null, exampleUsed: false, resumedPrompt: false });
    case "other_account_prompt_set_aside":
      return change(state, {
        textDraftId: null,
        promptOwner: null,
        exampleUsed: false,
        resumedPrompt: false,
        recoveryLocked: false,
      });
    case "send_started":
      return change(state, { submitting: true });
    case "send_finished":
      return change(state, { submitting: false });
    case "project_opening":
      return { ...state, opening: { fence: event.fence, href: event.href } };
    case "project_open_failed":
      return change(state, { opening: null });
  }
}
