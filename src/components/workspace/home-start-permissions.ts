/** Everything the Home prompt reads to decide what the person may do (docs/state-machines.md, J7). */
export type HomeStartSituation = {
  /** The projects kept on this device have been read. */
  draftsLoaded: boolean;
  /** The prompt kept for sign-in has been looked for. */
  recoveryLoaded: boolean;
  /** The kept prompt belongs to another account, so it is not shown. */
  hiddenPrompt: boolean;
  /** A send is under way, as last rendered. */
  submitting: boolean;
  /** The account save or start is in flight (`useAccountStrategyStart().pending`). */
  strategyPending: boolean;
  /** The prompt is tied to an earlier account save (`.locked`). */
  strategyLocked: boolean;
  /** That earlier save cannot be continued from here (`.recoveryBlocked`). */
  strategyRecoveryBlocked: boolean;
  /** The router is moving to the project. */
  navigating: boolean;
  /** A saved project is being opened in this account session. */
  opening: boolean;
  signedIn: boolean;
  /** Files are attached, as last rendered. */
  hasFiles: boolean;
  /** The attached save has frozen its project, as last rendered (`saveIntent.project`). */
  frozenBrief: boolean;
  /** Unsaved files are kept in this tab and nobody is signed in, as last rendered. */
  hiddenFiles: boolean;
  /** A file picker is open. */
  selectingFiles: boolean;
  /** The prompt already has a copy kept on this device. */
  keptDraft: boolean;
  /** This device holds 50 unsaved projects. */
  recoveryFull: boolean;
  /** Read at the moment of a click or keystroke, not from the last render. `null` while rendering: a
   * render answers no click, so `mayEdit` and `maySend` are then false. */
  now: HomeStartNow | null;
};

export type HomeStartNow = {
  /** A send is under way (the synchronous guard, ahead of the rendered `submitting`). */
  submitting: boolean;
  /** Unsaved files are kept and the account that owns them is absent or no longer current. */
  filesNeedAccount: boolean;
  /** An attached save has started, with or without a frozen project (`saveIntent`). */
  attachedSaveStarted: boolean;
};

/** One named answer per place that asks. They do NOT agree today, and each returns exactly what its
 * place computed before this function existed; `tests/client/home-start-permissions.test.ts` lists the
 * differences. Making them agree is a later change (docs/state-machines.md, rule 5). */
export type HomeStartView = {
  /** The prompt field is read-only; "Start a new prompt" and the example chips are disabled. */
  readOnly: boolean;
  /** Send and "Save project" are disabled. */
  sendDisabled: boolean;
  /** Voice and file controls are disabled. */
  inputControlsDisabled: boolean;
  /** A keystroke, an example or "Start a new prompt" is accepted. */
  mayEdit: boolean;
  /** A send goes past its first, silent check. Later checks answer with a message. */
  maySend: boolean;
};

/** Within each answer, the order of the checks is the order its place used. */
export function homeStartView(situation: HomeStartSituation): HomeStartView {
  const {
    recoveryLoaded,
    hiddenPrompt,
    submitting,
    strategyPending,
    strategyLocked,
    navigating,
    opening,
    hiddenFiles,
    frozenBrief,
    now,
  } = situation;
  const textRecoveryBlocked = situation.strategyRecoveryBlocked && !situation.hasFiles && !frozenBrief;
  return {
    readOnly:
      !recoveryLoaded ||
      hiddenPrompt ||
      submitting ||
      strategyPending ||
      strategyLocked ||
      navigating ||
      opening ||
      frozenBrief ||
      hiddenFiles,
    sendDisabled:
      !situation.draftsLoaded ||
      !recoveryLoaded ||
      textRecoveryBlocked ||
      (!situation.signedIn && !situation.keptDraft && situation.recoveryFull) ||
      submitting ||
      strategyPending ||
      navigating ||
      opening ||
      hiddenFiles ||
      situation.selectingFiles,
    inputControlsDisabled: !recoveryLoaded || submitting || navigating || strategyPending || strategyLocked,
    mayEdit:
      now !== null &&
      !hiddenPrompt &&
      !(!recoveryLoaded || now.submitting || strategyPending || strategyLocked || navigating || opening) &&
      !now.filesNeedAccount &&
      !now.attachedSaveStarted,
    maySend:
      now !== null &&
      !(
        !recoveryLoaded ||
        hiddenPrompt ||
        now.submitting ||
        navigating ||
        opening ||
        strategyPending ||
        textRecoveryBlocked
      ),
  };
}
