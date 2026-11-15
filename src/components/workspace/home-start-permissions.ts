/** Everything the Home prompt reads to decide what the person may do (docs/state-machines.md, J7).
 *
 * The screen asks with what it last rendered; a click or keystroke asks again with the values read at
 * that moment (`submitting` from the synchronous guard, the file memory read now). Both go through
 * `homeStartView`, so a control is disabled exactly when acting on it would be refused. */
export type HomeStartSituation = {
  /** The projects kept on this device have been read. */
  draftsLoaded: boolean;
  /** The prompt kept for sign-in has been looked for. */
  recoveryLoaded: boolean;
  /** The kept prompt belongs to another account, so it is not shown. */
  hiddenPrompt: boolean;
  /** A send is under way. At a click this includes the synchronous guard, which is ahead of the
   * rendered value: it only ever adds a refusal, it never allows what the screen shows as held. */
  submitting: boolean;
  /** The account save or start is in flight (`useAccountStrategyStart().pending`). */
  strategyPending: boolean;
  /** The prompt is tied to an earlier account save (`.locked`): the text of that save is kept as it
   * was, and Send repeats the same save or opens its project. */
  strategyLocked: boolean;
  /** That earlier save cannot be continued from here (`.recoveryBlocked`). */
  strategyRecoveryBlocked: boolean;
  /** The router is moving to the project. */
  navigating: boolean;
  /** A saved project is being opened in this account session. */
  opening: boolean;
  signedIn: boolean;
  /** Files are attached. */
  hasFiles: boolean;
  /** An attached save has started (`saveIntent`), which freezes the brief it was made from. */
  attachedSaveStarted: boolean;
  /** Unsaved files are kept in this tab and the account that owns them is absent or no longer current. */
  filesNeedAccount: boolean;
  /** A file picker is open. */
  selectingFiles: boolean;
  /** The prompt already has a copy kept on this device. */
  keptDraft: boolean;
  /** This device holds 50 unsaved projects. */
  recoveryFull: boolean;
};

/** One answer per question. */
export type HomeStartView = {
  /** The prompt text may not change: the field is read-only, and "Start a new prompt" and the example
   * chips are disabled. */
  editHeld: boolean;
  /** Voice and file controls are disabled. The same answer as `editHeld`, except during an attached
   * save: the file controls hold themselves then and keep their own way out ("Start a new attached
   * brief"), which disabling them from here would remove. */
  inputControlsHeld: boolean;
  /** Send and "Save project" are disabled. */
  sendHeld: boolean;
};

export function homeStartView(situation: HomeStartSituation): HomeStartView {
  const { hiddenPrompt, strategyLocked, attachedSaveStarted, filesNeedAccount } = situation;
  const notReady = !situation.draftsLoaded || !situation.recoveryLoaded;
  const busy = situation.submitting || situation.strategyPending || situation.navigating || situation.opening;
  // Nobody is signed in and this device has no room to keep another prompt: it could be neither kept
  // nor sent. The screen says so and links to recovery.
  const noRoom = !situation.signedIn && !situation.keptDraft && situation.recoveryFull;
  // Held for the prompt, its controls and Send alike.
  const held = notReady || busy || hiddenPrompt || filesNeedAccount || noRoom;
  const inputControlsHeld = held || strategyLocked;
  return {
    editHeld: inputControlsHeld || attachedSaveStarted,
    inputControlsHeld,
    // A locked prompt and a frozen attached brief stay sendable: Send repeats the same save. Typed text
    // alone cannot be sent while its earlier save cannot be continued. An open file picker holds Send
    // only: the text typed meanwhile is kept, and the picker has its own Cancel.
    sendHeld:
      held ||
      (situation.strategyRecoveryBlocked && !situation.hasFiles && !attachedSaveStarted) ||
      situation.selectingFiles,
  };
}
