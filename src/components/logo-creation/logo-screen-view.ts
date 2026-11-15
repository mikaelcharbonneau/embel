import type { LogoType } from "@/domain/logo-workspace";
import type { StepReply } from "@/features/logo-creation/model/step-reply";
import { LOGO_TYPE_LABELS } from "./presentation";

/**
 * What the Logo screen says, from the situation it is in (docs/state-machines.md, rule 4 and S2).
 * The screen gathers the situation from its hooks; this one function turns it into words, so the
 * priority of each sentence is written once and tested. Buttons, previews and what a click does
 * stay in the component.
 */
export type LogoScreenSituation = {
  /** The brand's name, or "your brand" before it has one. */
  brandName: string;
  /** The first read of the saved concepts: still loading, failed, or (null) answered. */
  savedRead: "loading" | "unavailable" | null;
  /** A set of concepts is on screen. */
  hasBatch: boolean;
  savedBatchLoading: boolean;
  savedBatchUnavailable: boolean;
  /** A concept on screen is still being drawn (the run's slots, or the saved set's own). */
  drawingNow: boolean;
  /** How many concepts the working run is drawing; 0 when it has not said yet. */
  drawingSlotCount: number;
  /** How many concepts of the set are ready to choose. */
  readyCount: number;
  /** How many concepts of the set failed and can be retried. */
  failedCount: number;
  /** A concepts run is working. */
  conceptRunActive: boolean;
  /** A refinement run is working. */
  refineRunActive: boolean;
  /** Any Logo run is working (concepts or a refinement). */
  runActive: boolean;
  /** Stop was asked and the run has not ended yet. */
  stopping: boolean;
  /** Logo drawing: on, switched off, or (null) not known yet. */
  engine: boolean | null;
  /** What the newest followed run ended as when it ended without its result, or null. */
  runEndSentence: string | null;
  /** A logo is chosen. */
  hasChosenLogo: boolean;
  /** "Concept 1 · Version 2" for the chosen logo; undefined when none is chosen. */
  chosenLabel: string | undefined;
  /** The choice is being saved. */
  choiceSaving: boolean;
  chosenLogoLoading: boolean;
  chosenLogoFailed: boolean;
  /** The followed refinement is still working. */
  refinementBusy: boolean;
  /** The followed refinement's result is saved and verified. */
  refinementReady: boolean;
  /** A change to the chosen logo can be started now. */
  canDescribeChange: boolean;
  /** The logo types chosen in the brief. */
  logoTypes: readonly LogoType[];
  /** The first set of concepts can be started now. */
  canStartConcepts: boolean;
  /** The account has no credits left. */
  noCredits: boolean;
  /** A chosen, saved, current logo: Creative direction may follow. */
  canContinue: boolean;
  /** The chosen logo was made before the brand details or liked images changed. */
  chosenLogoOutdated: boolean;
  /** The owner opens Creative direction itself (the project conversation). */
  continueHandled: boolean;
  /** Creative direction is already shown below. */
  continueHidden: boolean;
};

/** The reply box's plain state; the component adds what Send, Stop and removing a chip do. */
export type LogoScreenReplyBox = Omit<StepReply, "chips" | "send" | "stop">;
export type LogoScreenReply =
  /** Before the first set: the chips are the logo types, and Send draws the concepts. */
  | { stage: "types"; chips: { id: LogoType; label: string }[]; box: LogoScreenReplyBox }
  /** Once concepts exist: the chip is the chosen logo, and Send changes it or continues. */
  | { stage: "concepts"; chips: { id: string; label: string }[]; box: LogoScreenReplyBox };

export type LogoScreenView = {
  /** Under the change box outside the Workspace. */
  composerStatus: string;
  /** Why Continue is not available, for its tooltip while it is disabled. */
  continueHint: string;
  gridTitle: string;
  gridSubtitle: string;
  /** Concepts are being drawn, as the run or the set reports it. */
  conceptsDrawing: boolean;
  /** Some concepts failed and nothing is drawing: say so and offer the retry. */
  failedNow: boolean;
  /** Embel's message for this state, without what the last run ended as. */
  stateMessage: string;
  /** Embel's message in the chat: what the last run ended as, then what the person can do now. */
  stepMessage: string;
  /** The progress line in the chat, or null when nothing is working. */
  progressSentence: string | null;
  /** The reply box, or null while the saved concepts are not read yet. */
  reply: LogoScreenReply | null;
};

/** In each sentence the order of the checks is the priority. */
export function logoScreenView(situation: LogoScreenSituation): LogoScreenView {
  const {
    brandName,
    savedRead,
    hasBatch,
    savedBatchLoading,
    savedBatchUnavailable,
    drawingNow,
    readyCount,
    refineRunActive,
    runActive,
    hasChosenLogo,
    chosenLabel,
    choiceSaving,
    canDescribeChange,
    noCredits,
  } = situation;

  const savedReadMessage =
    savedRead === "unavailable" ? "Saved logo details unavailable." : "Loading saved logo details…";
  const composerStatus = choiceSaving
    ? "Saving your choice…"
    : situation.refinementBusy
      ? "Refining your logo…"
      : situation.refinementReady
        ? "Your refined logo is ready on its card."
        : savedRead
          ? savedReadMessage
          : !hasChosenLogo
            ? "Select a logo above to get started."
            : situation.chosenLogoLoading
              ? "Loading your chosen logo…"
              : situation.chosenLogoFailed
                ? "Your chosen logo could not be loaded. Try choosing it again."
                : situation.engine === false
                  ? "Changing logos is unavailable right now. Your message is kept."
                  : "";

  const continueHint = savedRead
    ? savedReadMessage
    : situation.chosenLogoOutdated
      ? "Choose a concept made with your current brand details and liked images"
      : "Select a logo and wait for it to save";

  const gridTitle = !hasBatch
    ? (drawingNow || runActive) && !savedBatchUnavailable
      ? "Drawing your concepts"
      : "Logo concepts"
    : drawingNow
      ? "Drawing your concepts"
      : hasChosenLogo && chosenLabel
        ? "Your logo"
        : "Choose the concept you like most";

  const gridSubtitle = savedBatchUnavailable
    ? "Saved concept details unavailable"
    : savedBatchLoading
      ? "Loading saved concepts…"
      : choiceSaving
        ? "Saving your choice…"
        : drawingNow || readyCount < 6
          ? `${readyCount} of 6 concepts ready`
          : "";

  const conceptsDrawing = drawingNow || situation.conceptRunActive;
  const failedNow = situation.failedCount > 0 && !conceptsDrawing;
  const chosenConcept = chosenLabel?.split(" · ")[0];
  const stateMessage = refineRunActive
    ? "I’m changing your logo."
    : conceptsDrawing
      ? `I’m drawing six concepts for ${brandName}.`
      : !hasBatch
        ? `Time for a logo. I’ll draw six concepts for ${brandName}, guided by the designs you liked.`
        : hasChosenLogo && chosenConcept
          ? `${chosenConcept} is your logo.`
          : failedNow
            ? ""
            : `Here are six concepts for ${brandName}.`;
  // A run that just ended without its result is said first, then what the person can do now.
  const stepMessage = [situation.runEndSentence, stateMessage].filter(Boolean).join(" ");

  const drawingCount = situation.drawingSlotCount || 6;
  const progressSentence = refineRunActive
    ? "Changing your logo."
    : conceptsDrawing
      ? drawingCount === 6
        ? "Drawing six logo concepts. This usually takes about a minute."
        : `Drawing ${drawingCount === 1 ? "one logo concept" : `${drawingCount} logo concepts`}.`
      : null;

  // The reply box (decision 2): logo types as chips before the first set, the chosen concept once there is one.
  const reply: LogoScreenReply | null = savedRead
    ? null
    : !hasBatch
      ? {
          stage: "types",
          chips: situation.logoTypes.map((type) => ({ id: type, label: LOGO_TYPE_LABELS[type] })),
          box: {
            step: "logo",
            placeholder: "Choose the logo types, then press Send…",
            sendLabel: "Draw six concepts",
            canSend: situation.canStartConcepts && !noCredits,
            acceptsText: false,
            outOfCredits: noCredits,
            working: runActive,
            stopLabel: "Stop drawing",
            stopping: situation.stopping,
          },
        }
      : {
          stage: "concepts",
          chips: chosenLabel && hasChosenLogo ? [{ id: "logo", label: `Logo: ${chosenLabel}` }] : [],
          box: {
            step: "logo",
            placeholder: hasChosenLogo
              ? "Describe a change, or press Send to continue…"
              : "Choose a concept, then press Send…",
            sendLabel: "Continue to Creative direction",
            // Send continues where the owner opens Creative direction, as in the Workspace.
            canSend:
              situation.canContinue &&
              situation.continueHandled &&
              !situation.continueHidden &&
              !noCredits &&
              !runActive,
            acceptsText: canDescribeChange,
            outOfCredits: noCredits,
            working: runActive,
            stopLabel: refineRunActive ? "Stop changing the logo" : "Stop drawing",
            stopping: situation.stopping,
          },
        };

  return {
    composerStatus,
    continueHint,
    gridTitle,
    gridSubtitle,
    conceptsDrawing,
    failedNow,
    stateMessage,
    stepMessage,
    progressSentence,
    reply,
  };
}
