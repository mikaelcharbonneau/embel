/**
 * What the Logo and Creative direction steps ask of a Send-driven reply box (handoff decision 2: Send is the one way
 * forward; chosen options and results sit in the reply box as chips; Stop takes Send's place while Embel works).
 *
 * A step given `onReplyChange` reports this whenever it changes, and `null` when it has nothing for the reply box.
 * With `reply="external"` the step also hides its own start, Continue and change controls, so the reply box is the one
 * way forward; with the default `reply="inline"` the step keeps them and the report is informational.
 *
 * The step owns every request: `send` starts exactly the request the step would start from its own control (one
 * deliberate click, the same server admission), and does nothing when `canSend` is false.
 */
export type StepReplyChip = {
  id: string;
  /** "Wordmark", "Logo: Concept 1 · Version 2", "Direction: Editorial Soft Shapes". */
  label: string;
  /** Removable chips (logo types) take the choice back; static chips (a chosen result) have none. */
  onRemove?: () => void;
};

export type StepReply = {
  step: "logo" | "direction";
  chips: StepReplyChip[];
  /** The reply box's placeholder for this state. */
  placeholder: string;
  /** What Send does with nothing typed, for its label and tooltip ("Draw six concepts", "Continue to Creative direction"). */
  sendLabel: string;
  /** Send is available. False before a choice is made, while a choice saves, or while Embel works. */
  canSend: boolean;
  /** Whether typed text is used. Concepts take no note today (the request has no field for one), so it is false then. */
  acceptsText: boolean;
  /**
   * The account has 0 credits and Send would start paid work: the step marks it in place (D-014) and Send stays
   * unavailable. The server still admits or refuses every request.
   */
  outOfCredits: boolean;
  /** Embel is working on this step: show Stop in Send's place. */
  working: boolean;
  /** Stop's label and tooltip ("Stop drawing"). */
  stopLabel?: string;
  /** Sends the reply. With text and `acceptsText`, the text is a change to the chosen result; without, Send continues. */
  send(text: string): void;
  stop?(): void;
};
