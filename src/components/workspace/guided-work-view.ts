import type { GuidedStage } from "@/domain/guided-interview";
import type { JourneyStepId } from "@/domain/journey";

/** The one step the work area of the project conversation shows (docs/state-machines.md, J4). */
export type WorkView = "choices" | "naming" | "slogan" | "inspiration" | "logo" | "directions";

/** How far the saved project has come, read from the address of its next step. Each value includes the
 * ones before it: a project whose next step is Assets has also reached Creative direction and Logo. */
export type ProjectReach = "logo" | "directions" | "assets" | null;

/** `nextPath` is the project's next address without its query and hash; `projectBase` is the project's own. */
export function projectReach(nextPath: string | undefined, projectBase: string): ProjectReach {
  if (nextPath?.startsWith(`${projectBase}/logo/deliverables`)) return "assets";
  if (nextPath?.startsWith(`${projectBase}/logo/directions`)) return "directions";
  if (nextPath?.startsWith(`${projectBase}/logo`)) return "logo";
  return null;
}

// ----- What the person opened and closed -----

/** The open and closed parts of the work area that only this page remembers. Nothing here is saved. */
export type WorkAreaState = {
  /** The names were reopened with Change name while this name was the chosen one; null when they are not. */
  namingReopenedFor: string | null;
  /** The brief editor, and where it was opened from: the names stay behind it only when opened from them. */
  brief: "closed" | "from_naming" | "from_conversation";
  /** Send on Inspiration opened the Logo step. */
  logoOpened: boolean;
  /** Send on Logo opened the Creative direction step. */
  directionsOpened: boolean;
  /** A finished step reopened from its folded entry in the chat. */
  reopened: WorkView | null;
  /** A `#journey-logo` link was followed; it opens the Logo step even when the project has moved past it. */
  linkedLogo: boolean;
  /** The part of the chat opened from the project bar, while it is not the step on screen. */
  sectionViewed: JourneyStepId | null;
};

export type WorkAreaEvent =
  /** The person pressed Change name on the folded name. */
  | { type: "chose_to_change_name"; selectedName: string }
  /** The person confirmed a name in the names. */
  | { type: "confirmed_name" }
  /** The saved name is no longer the one the names were reopened for. */
  | { type: "saved_name_changed" }
  /** The person opened the brief editor; `fromNaming` says whether the names were on screen. */
  | { type: "opened_brief"; fromNaming: boolean }
  | { type: "closed_brief" }
  /** The person pressed a "Change …" button on a folded Identity step. */
  | { type: "reopened_step"; step: WorkView }
  /** Send on Inspiration: on to Logo, leaving any reopened step. */
  | { type: "continued_to_logo" }
  /** Send on Logo: on to Creative direction, leaving any reopened step. */
  | { type: "continued_to_directions" }
  /** The address now points at `#journey-logo`. */
  | { type: "logo_link_arrived" }
  /** A step of the project bar (or a `#journey-…` link) asked for its part of the chat. */
  | { type: "section_requested"; step: JourneyStepId; stepOnScreen: JourneyStepId }
  /** The step on screen became the part of the chat that was opened from the bar. */
  | { type: "viewed_section_on_screen" };

export function initialWorkAreaState({ logoLinked }: { logoLinked: boolean }): WorkAreaState {
  return {
    namingReopenedFor: null,
    brief: "closed",
    logoOpened: false,
    directionsOpened: false,
    reopened: null,
    linkedLogo: logoLinked,
    sectionViewed: null,
  };
}

/** Returns the same object when an event changes nothing, so the page does not render again for it. */
export function workAreaReducer(state: WorkAreaState, event: WorkAreaEvent): WorkAreaState {
  const change = (next: Partial<WorkAreaState>): WorkAreaState =>
    (Object.keys(next) as (keyof WorkAreaState)[]).every((key) => state[key] === next[key])
      ? state
      : { ...state, ...next };
  switch (event.type) {
    case "chose_to_change_name":
      return change({ namingReopenedFor: event.selectedName });
    case "confirmed_name":
    case "saved_name_changed":
      return change({ namingReopenedFor: null });
    case "opened_brief":
      return change({ brief: event.fromNaming ? "from_naming" : "from_conversation" });
    case "closed_brief":
      return change({ brief: "closed" });
    case "reopened_step":
      return change({ reopened: event.step });
    case "continued_to_logo":
      return change({ reopened: null, linkedLogo: false, logoOpened: true });
    case "continued_to_directions":
      return change({ reopened: null, linkedLogo: false, directionsOpened: true });
    case "logo_link_arrived":
      return change({ linkedLogo: true });
    case "section_requested": {
      const sectionViewed = event.step === event.stepOnScreen ? null : event.step;
      // Identity always shows its latest step: a reopened one and a followed Logo link are left.
      return change(
        event.step === "identity" ? { reopened: null, linkedLogo: false, sectionViewed } : { sectionViewed },
      );
    }
    case "viewed_section_on_screen":
      return change({ sectionViewed: null });
  }
}

// ----- What the work area shows -----

/** Everything the work area's view is worked out from: the page's own state plus what is saved and loaded. */
export type WorkViewSituation = WorkAreaState & {
  /** The conversation's saved stage; null when the project has no conversation yet. */
  stage: GuidedStage | "complete" | null;
  /** The project is a complete brand (not a single tool's project). */
  completeBrand: boolean;
  /** Strategy is confirmed and saved, with nothing unsaved or in conflict: the names may open. */
  namingReady: boolean;
  /** The saved Strategy requests have been read, or reading them failed. */
  historyChecked: boolean;
  /** A name is chosen. */
  nameSelected: boolean;
  /** Slogans have been proposed at least once. */
  sloganProposed: boolean;
  /** The personality question has an answer. */
  personalityAnswered: boolean;
  /** The chat holds a personality or slogan turn. */
  voiceTurnInChat: boolean;
  /** How far the saved project has come. */
  projectReach: ProjectReach;
  /** The address's hash, `""` when there is none. */
  hash: string;
};

export type WorkAreaView = {
  /** The names are part of this page (open or folded). */
  showNaming: boolean;
  /** A name is chosen and its slogans were proposed: the names fold into one answer. */
  nameChosen: boolean;
  /** The names are open in the work area. */
  namingOpen: boolean;
  /** The furthest journey step this conversation has reached. */
  reached: JourneyStepId;
  voiceShown: boolean;
  identityShown: boolean;
  logoShown: boolean;
  directionsShown: boolean;
  /** The project's next step is Assets: the brand is finished. */
  finished: boolean;
  /** The step the work area would show with nothing reopened. */
  latestView: WorkView;
  /** The step the work area shows. */
  view: WorkView;
  /** The journey step `view` belongs to. */
  viewStep: JourneyStepId;
  /** A finished brand shows the brand itself instead of the three boards. */
  brandShown: boolean;
  /** The parts of the chat that exist. */
  sections: JourneyStepId[];
  /** The step the project bar marks as current. */
  barStep: JourneyStepId;
};

/** The order of the checks is the priority: open names win over everything, then a step the person asked
 * for (reopened from its folded entry, or a followed Logo link) when the project has it, then the latest
 * step the project has reached. */
export function workAreaView(situation: WorkViewSituation): WorkAreaView {
  const { stage, completeBrand, historyChecked, projectReach: reach, hash, reopened } = situation;
  const showNaming =
    (situation.brief !== "closed" ? situation.brief === "from_naming" : situation.namingReady) && historyChecked;
  // Once a name is chosen and the slogan is proposed for it, the names fold into
  // one answer and the conversation continues. Change name reopens them.
  const nameChosen = situation.nameSelected && situation.sloganProposed;
  const namingOpen = showNaming && (!nameChosen || situation.namingReopenedFor !== null);
  const reached: JourneyStepId =
    showNaming || stage === "personality" || stage === "slogan" || stage === "complete" ? "voice" : "strategy";

  // Strategy, then Voice from the first personality question on, then Identity
  // (Inspiration) once Voice is finished: the slogan answered or skipped.
  const voiceShown = reached === "voice" || situation.personalityAnswered || situation.voiceTurnInChat;
  const identityShown = stage === "complete" && nameChosen && completeBrand;
  // Logo and Creative direction follow Inspiration, each after the previous step's
  // Send, when the project has already reached it, or when a link points at it.
  const logoReached = reach !== null;
  const directionsReached = reach === "directions" || reach === "assets";
  const finished = reach === "assets";
  const logoLinked = hash === "#journey-logo",
    directionsLinked = hash === "#journey-directions";
  const logoShown =
    identityShown && historyChecked && (situation.logoOpened || logoLinked || directionsLinked || logoReached);
  const directionsShown = logoShown && (situation.directionsOpened || directionsLinked || directionsReached);

  // The work area shows one step: the latest one, or a finished one reopened from its folded entry in the chat.
  const latestView: WorkView = namingOpen
    ? "naming"
    : identityShown
      ? directionsShown
        ? "directions"
        : logoShown
          ? "logo"
          : "inspiration"
      : stage === "slogan" || (stage === "complete" && completeBrand)
        ? "slogan"
        : "choices";
  // A link to the Logo step opens it even when the project has moved past it.
  const requested = reopened ?? (situation.linkedLogo && logoShown && !directionsLinked ? "logo" : null);
  const view: WorkView =
    !namingOpen &&
    requested &&
    ((requested === "inspiration" && identityShown) ||
      (requested === "logo" && logoShown) ||
      (requested === "directions" && directionsShown))
      ? requested
      : latestView;
  const viewStep: JourneyStepId =
    view === "choices"
      ? stage === "personality"
        ? "voice"
        : "strategy"
      : view === "naming" || view === "slogan"
        ? "voice"
        : "identity";
  // A finished brand shows the brand itself; Change direction on its folded entry reopens the three boards.
  const brandShown = finished && view === "directions" && reopened !== "directions";

  const sections: JourneyStepId[] = identityShown
    ? ["strategy", "voice", "identity"]
    : voiceShown
      ? ["strategy", "voice"]
      : ["strategy"];
  return {
    showNaming,
    nameChosen,
    namingOpen,
    reached,
    voiceShown,
    identityShown,
    logoShown,
    directionsShown,
    finished,
    latestView,
    view,
    viewStep,
    brandShown,
    sections,
    barStep: situation.sectionViewed ?? viewStep,
  };
}
