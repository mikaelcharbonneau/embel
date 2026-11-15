import { describe, expect, it } from "vitest";
import { logoScreenView, type LogoScreenSituation } from "@/components/logo-creation/logo-screen-view";

// One function says what the Logo screen shows (docs/state-machines.md, rule 4 and S2). Each test walks one
// sentence down its checks: the order is the priority.
const first: LogoScreenSituation = {
  brandName: "Northwind",
  savedRead: null,
  hasBatch: false,
  savedBatchLoading: false,
  savedBatchUnavailable: false,
  drawingNow: false,
  drawingSlotCount: 0,
  readyCount: 0,
  failedCount: 0,
  conceptRunActive: false,
  refineRunActive: false,
  runActive: false,
  stopping: false,
  engine: true,
  runEndSentence: null,
  hasChosenLogo: false,
  chosenLabel: undefined,
  choiceSaving: false,
  chosenLogoLoading: false,
  chosenLogoFailed: false,
  refinementBusy: false,
  refinementReady: false,
  canDescribeChange: false,
  logoTypes: ["wordmark", "emblem"],
  canStartConcepts: true,
  noCredits: false,
  canContinue: false,
  chosenLogoOutdated: false,
  continueHandled: true,
  continueHidden: false,
};
const concepts: LogoScreenSituation = { ...first, hasBatch: true, readyCount: 6 };
const chosen: LogoScreenSituation = {
  ...concepts,
  hasChosenLogo: true,
  chosenLabel: "Concept 2 · Version 3",
  canContinue: true,
  canDescribeChange: true,
};
const view = (situation: LogoScreenSituation, change: Partial<LogoScreenSituation> = {}) =>
  logoScreenView({ ...situation, ...change });

describe("the line under the change box", () => {
  it("says the first thing that is true, in this order", () => {
    const all: Partial<LogoScreenSituation> = {
      choiceSaving: true,
      refinementBusy: true,
      refinementReady: true,
      savedRead: "loading",
      chosenLogoLoading: true,
      chosenLogoFailed: true,
      engine: false,
    };
    expect(view(chosen, all).composerStatus).toBe("Saving your choice…");
    expect(view(chosen, { ...all, choiceSaving: false }).composerStatus).toBe("Refining your logo…");
    expect(view(chosen, { ...all, choiceSaving: false, refinementBusy: false }).composerStatus).toBe(
      "Your refined logo is ready on its card.",
    );
    const read = { ...all, choiceSaving: false, refinementBusy: false, refinementReady: false };
    expect(view(chosen, read).composerStatus).toBe("Loading saved logo details…");
    expect(view(chosen, { ...read, savedRead: "unavailable" }).composerStatus).toBe("Saved logo details unavailable.");
    expect(view(chosen, { ...read, savedRead: null, hasChosenLogo: false }).composerStatus).toBe(
      "Select a logo above to get started.",
    );
    expect(view(chosen, { ...read, savedRead: null }).composerStatus).toBe("Loading your chosen logo…");
    expect(view(chosen, { ...read, savedRead: null, chosenLogoLoading: false }).composerStatus).toBe(
      "Your chosen logo could not be loaded. Try choosing it again.",
    );
    expect(view(chosen, { engine: false }).composerStatus).toBe(
      "Changing logos is unavailable right now. Your message is kept.",
    );
  });

  it("says nothing when the chosen logo is ready, or while drawing is not known to be off", () => {
    expect(view(chosen).composerStatus).toBe("");
    expect(view(chosen, { engine: null }).composerStatus).toBe("");
  });
});

describe("why Continue is unavailable", () => {
  it("names the saved read first, then an outdated logo, then the missing choice", () => {
    expect(view(chosen, { savedRead: "loading", chosenLogoOutdated: true }).continueHint).toBe(
      "Loading saved logo details…",
    );
    expect(view(chosen, { savedRead: "unavailable" }).continueHint).toBe("Saved logo details unavailable.");
    expect(view(chosen, { chosenLogoOutdated: true }).continueHint).toBe(
      "Choose a concept made with your current brand details and liked images",
    );
    expect(view(concepts).continueHint).toBe("Select a logo and wait for it to save");
  });
});

describe("the concepts heading", () => {
  it("before a set is on screen: drawing only while something works and the saved set is readable", () => {
    expect(view(first).gridTitle).toBe("Logo concepts");
    expect(view(first, { drawingNow: true }).gridTitle).toBe("Drawing your concepts");
    expect(view(first, { runActive: true }).gridTitle).toBe("Drawing your concepts");
    expect(view(first, { runActive: true, drawingNow: true, savedBatchUnavailable: true }).gridTitle).toBe(
      "Logo concepts",
    );
  });

  it("with a set on screen: drawing, then the chosen logo, then the invitation to choose", () => {
    expect(view(chosen, { drawingNow: true }).gridTitle).toBe("Drawing your concepts");
    expect(view(chosen).gridTitle).toBe("Your logo");
    expect(view(concepts).gridTitle).toBe("Choose the concept you like most");
    // A refinement working does not make the heading say drawing; an unreadable saved set does not change it.
    expect(view(concepts, { runActive: true, refineRunActive: true }).gridTitle).toBe(
      "Choose the concept you like most",
    );
    expect(view(chosen, { savedBatchUnavailable: true }).gridTitle).toBe("Your logo");
    // A chosen logo without a label is not named.
    expect(view(chosen, { chosenLabel: "" }).gridTitle).toBe("Choose the concept you like most");
  });

  it("says under it: unavailable, loading, saving, then the count until all six are ready", () => {
    const all = { savedBatchUnavailable: true, savedBatchLoading: true, choiceSaving: true };
    expect(view(chosen, all).gridSubtitle).toBe("Saved concept details unavailable");
    expect(view(chosen, { ...all, savedBatchUnavailable: false }).gridSubtitle).toBe("Loading saved concepts…");
    expect(view(chosen, { choiceSaving: true }).gridSubtitle).toBe("Saving your choice…");
    expect(view(chosen).gridSubtitle).toBe("");
    expect(view(concepts).gridSubtitle).toBe("");
    expect(view(chosen, { drawingNow: true, readyCount: 4 }).gridSubtitle).toBe("4 of 6 concepts ready");
    expect(view(concepts, { readyCount: 5 }).gridSubtitle).toBe("5 of 6 concepts ready");
    expect(view(chosen, { readyCount: 3 }).gridSubtitle).toBe("3 of 6 concepts ready");
  });
});

describe("Embel's message in the chat", () => {
  it("says a change first, then drawing, then the state of the concepts", () => {
    expect(view(chosen, { refineRunActive: true, conceptRunActive: true, drawingNow: true }).stateMessage).toBe(
      "I’m changing your logo.",
    );
    for (const drawing of [{ drawingNow: true }, { conceptRunActive: true }])
      for (const situation of [first, chosen])
        expect(view(situation, drawing).stateMessage).toBe("I’m drawing six concepts for Northwind.");
    expect(view(first).stateMessage).toBe(
      "Time for a logo. I’ll draw six concepts for Northwind, guided by the designs you liked.",
    );
    expect(view(chosen).stateMessage).toBe("Concept 2 is your logo.");
    expect(view(chosen, { canDescribeChange: false }).stateMessage).toBe("Concept 2 is your logo.");
    expect(view(concepts).stateMessage).toBe("Here are six concepts for Northwind.");
  });

  it("leaves failed concepts to their own message, unless a logo is already chosen", () => {
    expect(view(concepts, { failedCount: 2 })).toMatchObject({ failedNow: true, stateMessage: "" });
    expect(view(chosen, { failedCount: 2 }).stateMessage).toMatch(/^Concept 2 is your logo\./);
    // While concepts draw, earlier failures are not said.
    for (const drawing of [{ drawingNow: true }, { conceptRunActive: true }])
      expect(view(concepts, { failedCount: 2, ...drawing })).toMatchObject({ failedNow: false, conceptsDrawing: true });
    // A change in progress does not hide them.
    expect(view(concepts, { failedCount: 1, refineRunActive: true }).failedNow).toBe(true);
    expect(view(concepts)).toMatchObject({ failedNow: false, conceptsDrawing: false });
  });

  it("says what the last run ended as before what to do now", () => {
    expect(view(concepts, { runEndSentence: "I stopped drawing." }).stepMessage).toBe(
      "I stopped drawing. Here are six concepts for Northwind.",
    );
    expect(view(concepts, { runEndSentence: "I stopped drawing.", failedCount: 1 }).stepMessage).toBe(
      "I stopped drawing.",
    );
    expect(view(concepts, { failedCount: 1 }).stepMessage).toBe("");
    expect(view(concepts).stepMessage).toBe(view(concepts).stateMessage);
  });

  it("shows progress for a change, then for the number of concepts being drawn", () => {
    expect(view(chosen).progressSentence).toBeNull();
    expect(view(chosen, { refineRunActive: true, drawingNow: true, drawingSlotCount: 2 }).progressSentence).toBe(
      "Changing your logo.",
    );
    const six = "Drawing six logo concepts. This usually takes about a minute.";
    expect(view(first, { conceptRunActive: true }).progressSentence).toBe(six);
    expect(view(first, { drawingNow: true, drawingSlotCount: 6 }).progressSentence).toBe(six);
    expect(view(concepts, { drawingNow: true, drawingSlotCount: 1 }).progressSentence).toBe(
      "Drawing one logo concept.",
    );
    expect(view(concepts, { drawingNow: true, drawingSlotCount: 2 }).progressSentence).toBe("Drawing 2 logo concepts.");
  });
});

describe("the reply box", () => {
  it("has nothing to offer until the saved concepts are read", () => {
    for (const savedRead of ["loading", "unavailable"] as const)
      for (const situation of [first, chosen]) expect(view(situation, { savedRead }).reply).toBeNull();
  });

  it("before the first set: the logo types as chips, and Send draws six concepts", () => {
    expect(view(first).reply).toEqual({
      stage: "types",
      chips: [
        { id: "wordmark", label: "Wordmark" },
        { id: "emblem", label: "Emblem" },
      ],
      box: {
        step: "logo",
        placeholder: "Choose the logo types, then press Send…",
        sendLabel: "Draw six concepts",
        canSend: true,
        acceptsText: false,
        outOfCredits: false,
        working: false,
        stopLabel: "Stop drawing",
        stopping: false,
      },
    });
    expect(view(first, { canStartConcepts: false }).reply?.box.canSend).toBe(false);
    expect(view(first, { noCredits: true }).reply?.box).toMatchObject({ canSend: false, outOfCredits: true });
    // A run on its way keeps the types stage until its set is on screen; a change in progress is still "drawing" here.
    expect(view(first, { runActive: true, refineRunActive: true, stopping: true }).reply?.box).toMatchObject({
      working: true,
      stopping: true,
      stopLabel: "Stop drawing",
      canSend: true,
      acceptsText: false,
    });
  });

  it("once concepts exist: the chosen logo as a chip, text is a change and Send continues", () => {
    expect(view(chosen).reply).toEqual({
      stage: "concepts",
      chips: [{ id: "logo", label: "Logo: Concept 2 · Version 3" }],
      box: {
        step: "logo",
        placeholder: "Describe a change, or press Send to continue…",
        sendLabel: "Continue to Creative direction",
        canSend: true,
        acceptsText: true,
        outOfCredits: false,
        working: false,
        stopLabel: "Stop drawing",
        stopping: false,
      },
    });
    expect(view(concepts).reply).toMatchObject({
      chips: [],
      box: { placeholder: "Choose a concept, then press Send…", canSend: false, acceptsText: false },
    });
    expect(view(chosen, { chosenLabel: "" }).reply?.chips).toEqual([]);
  });

  it("Send continues only with a saved choice, an owner that opens the next step, credits and no run", () => {
    for (const change of [
      { canContinue: false },
      { continueHandled: false },
      { continueHidden: true },
      { noCredits: true },
      { runActive: true },
    ])
      expect(view(chosen, change).reply?.box.canSend, JSON.stringify(change)).toBe(false);
    expect(view(chosen, { runActive: true, refineRunActive: true }).reply?.box).toMatchObject({
      working: true,
      stopLabel: "Stop changing the logo",
    });
    expect(view(chosen, { runActive: true, conceptRunActive: true }).reply?.box.stopLabel).toBe("Stop drawing");
  });
});
