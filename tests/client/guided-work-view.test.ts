import { describe, expect, it } from "vitest";
import {
  initialWorkAreaState,
  projectReach,
  workAreaReducer,
  workAreaView,
  type WorkAreaEvent,
  type WorkAreaState,
  type WorkViewSituation,
} from "@/components/workspace/guided-work-view";

// The work area of the project conversation (docs/state-machines.md, J4).
const closed = initialWorkAreaState({ logoLinked: false });
const start: WorkViewSituation = {
  ...closed,
  stage: null,
  completeBrand: true,
  namingReady: false,
  historyChecked: true,
  nameSelected: false,
  sloganProposed: false,
  personalityAnswered: false,
  voiceTurnInChat: false,
  projectReach: null,
  hash: "",
};
const naming: WorkViewSituation = { ...start, stage: "slogan", namingReady: true, personalityAnswered: true };
const slogan: WorkViewSituation = { ...naming, nameSelected: true, sloganProposed: true, voiceTurnInChat: true };
const identity: WorkViewSituation = { ...slogan, stage: "complete" };
const after = (...events: WorkAreaEvent[]) => events.reduce(workAreaReducer, closed);

describe("what the work area shows", () => {
  it("shows the question of each Strategy stage, and files Personality under Voice", () => {
    expect(workAreaView(start)).toMatchObject({
      view: "choices",
      viewStep: "strategy",
      reached: "strategy",
      sections: ["strategy"],
      barStep: "strategy",
    });
    for (const stage of ["competitors", "audience", "positioning"] as const)
      expect(workAreaView({ ...start, stage })).toMatchObject({ view: "choices", viewStep: "strategy" });
    expect(workAreaView({ ...start, stage: "personality" })).toMatchObject({
      view: "choices",
      viewStep: "voice",
      reached: "voice",
      sections: ["strategy", "voice"],
    });
    // A personality answer or turn keeps the Voice part after a move back to Strategy.
    expect(workAreaView({ ...start, stage: "audience", personalityAnswered: true }).sections).toEqual([
      "strategy",
      "voice",
    ]);
    expect(workAreaView({ ...start, stage: "audience", voiceTurnInChat: true })).toMatchObject({
      reached: "strategy",
      voiceShown: true,
    });
  });

  it("opens the names once Strategy is ready and the saved requests were read", () => {
    expect(workAreaView(naming)).toMatchObject({ view: "naming", namingOpen: true, viewStep: "voice" });
    expect(workAreaView({ ...naming, historyChecked: false })).toMatchObject({ view: "slogan", namingOpen: false });
    expect(workAreaView({ ...naming, stage: "audience", namingReady: false }).view).toBe("choices");
  });

  it("folds the names once a name is chosen and slogans were proposed; Change name reopens them", () => {
    expect(workAreaView(slogan)).toMatchObject({ view: "slogan", nameChosen: true, namingOpen: false });
    expect(workAreaView({ ...slogan, sloganProposed: false })).toMatchObject({ view: "naming", nameChosen: false });
    expect(workAreaView({ ...slogan, namingReopenedFor: "Lumo" }).view).toBe("naming");
    // Open names win over a reopened step and a followed link.
    expect(
      workAreaView({ ...identity, namingReopenedFor: "Lumo", reopened: "inspiration", linkedLogo: true }).view,
    ).toBe("naming");
  });

  it("keeps the names behind the brief editor only when it was opened from them", () => {
    expect(workAreaView({ ...naming, namingReady: false, brief: "from_naming" }).showNaming).toBe(true);
    expect(workAreaView({ ...naming, brief: "from_conversation" })).toMatchObject({
      showNaming: false,
      view: "slogan",
    });
    expect(workAreaView({ ...naming, brief: "from_naming", historyChecked: false }).showNaming).toBe(false);
  });

  it("moves to Identity when the conversation is complete with a folded name on a complete brand", () => {
    expect(workAreaView(identity)).toMatchObject({
      view: "inspiration",
      viewStep: "identity",
      reached: "voice",
      sections: ["strategy", "voice", "identity"],
    });
    expect(workAreaView({ ...identity, completeBrand: false })).toMatchObject({
      view: "choices",
      identityShown: false,
    });
    expect(workAreaView({ ...identity, nameSelected: false, namingReady: false }).view).toBe("slogan");
  });

  it("shows Logo and Creative direction after Send, when the project reached them, or from a link", () => {
    expect(workAreaView({ ...identity, logoOpened: true }).view).toBe("logo");
    expect(workAreaView({ ...identity, projectReach: "logo" }).view).toBe("logo");
    expect(workAreaView({ ...identity, hash: "#journey-logo" }).view).toBe("logo");
    expect(workAreaView({ ...identity, logoOpened: true, directionsOpened: true }).view).toBe("directions");
    expect(workAreaView({ ...identity, projectReach: "directions" }).view).toBe("directions");
    expect(workAreaView({ ...identity, hash: "#journey-directions" }).view).toBe("directions");
    // Creative direction never shows without Logo, and neither before the saved requests were read.
    expect(workAreaView({ ...identity, directionsOpened: true })).toMatchObject({
      view: "inspiration",
      directionsShown: false,
    });
    expect(workAreaView({ ...identity, projectReach: "directions", historyChecked: false }).view).toBe("inspiration");
    // The links do nothing before Identity.
    expect(workAreaView({ ...slogan, hash: "#journey-logo", linkedLogo: true }).view).toBe("slogan");
  });

  it("shows a reopened step only when the project has it", () => {
    const reachedDirections: WorkViewSituation = { ...identity, projectReach: "directions" };
    expect(workAreaView({ ...reachedDirections, reopened: "inspiration" })).toMatchObject({
      view: "inspiration",
      latestView: "directions",
    });
    expect(workAreaView({ ...reachedDirections, reopened: "logo" }).view).toBe("logo");
    expect(workAreaView({ ...identity, reopened: "logo" }).view).toBe("inspiration");
    expect(workAreaView({ ...identity, projectReach: "logo", reopened: "directions" }).view).toBe("logo");
    // Only Identity steps reopen this way.
    expect(workAreaView({ ...reachedDirections, reopened: "slogan" }).view).toBe("directions");
  });

  it("lets a followed Logo link open Logo on a project that moved past it", () => {
    expect(workAreaView({ ...identity, projectReach: "directions", linkedLogo: true }).view).toBe("logo");
    // A reopened step wins over the link, and a Creative direction link cancels it.
    expect(
      workAreaView({ ...identity, projectReach: "directions", linkedLogo: true, reopened: "inspiration" }).view,
    ).toBe("inspiration");
    expect(
      workAreaView({ ...identity, projectReach: "directions", linkedLogo: true, hash: "#journey-directions" }).view,
    ).toBe("directions");
  });

  it("shows a finished brand as the brand until Change direction reopens the boards", () => {
    const done: WorkViewSituation = { ...identity, projectReach: "assets" };
    expect(workAreaView(done)).toMatchObject({ view: "directions", finished: true, brandShown: true });
    expect(workAreaView({ ...done, reopened: "directions" })).toMatchObject({ view: "directions", brandShown: false });
    expect(workAreaView({ ...done, reopened: "logo" })).toMatchObject({ view: "logo", brandShown: false });
    expect(workAreaView({ ...identity, projectReach: "directions" })).toMatchObject({
      finished: false,
      brandShown: false,
    });
  });

  it("marks the part of the chat opened from the bar instead of the step on screen", () => {
    expect(workAreaView({ ...identity, sectionViewed: "strategy" })).toMatchObject({
      barStep: "strategy",
      viewStep: "identity",
    });
    expect(workAreaView(identity).barStep).toBe("identity");
  });
});

describe("how far the saved project has come", () => {
  const base = "/brands/account/p1";
  it("reads it from the address of the next step", () => {
    expect(projectReach(undefined, base)).toBeNull();
    expect(projectReach(base, base)).toBeNull();
    expect(projectReach("/brands/account/p2/logo", base)).toBeNull();
    expect(projectReach(`${base}/logo`, base)).toBe("logo");
    expect(projectReach(`${base}/logo/directions`, base)).toBe("directions");
    expect(projectReach(`${base}/logo/deliverables`, base)).toBe("assets");
  });
});

describe("what the person opened and closed", () => {
  it("starts closed, with a Logo link already followed when the page opened on it", () => {
    expect(closed).toEqual<WorkAreaState>({
      namingReopenedFor: null,
      brief: "closed",
      logoOpened: false,
      directionsOpened: false,
      reopened: null,
      linkedLogo: false,
      sectionViewed: null,
    });
    expect(initialWorkAreaState({ logoLinked: true }).linkedLogo).toBe(true);
  });

  it("reopens the names for the chosen name and closes them on a confirmed or changed name", () => {
    const open = after({ type: "chose_to_change_name", selectedName: "Lumo" });
    expect(open.namingReopenedFor).toBe("Lumo");
    // A project without a saved name reopens for the empty name, which still counts as reopened.
    expect(after({ type: "chose_to_change_name", selectedName: "" }).namingReopenedFor).toBe("");
    expect(workAreaReducer(open, { type: "confirmed_name" }).namingReopenedFor).toBeNull();
    expect(workAreaReducer(open, { type: "saved_name_changed" }).namingReopenedFor).toBeNull();
  });

  it("remembers where the brief editor was opened from", () => {
    expect(after({ type: "opened_brief", fromNaming: true }).brief).toBe("from_naming");
    expect(after({ type: "opened_brief", fromNaming: false }).brief).toBe("from_conversation");
    expect(after({ type: "opened_brief", fromNaming: true }, { type: "closed_brief" }).brief).toBe("closed");
  });

  it("leaves a reopened step and a followed link when Send continues", () => {
    const reopened = after({ type: "logo_link_arrived" }, { type: "reopened_step", step: "inspiration" });
    expect(reopened).toMatchObject({ reopened: "inspiration", linkedLogo: true });
    expect(workAreaReducer(reopened, { type: "continued_to_logo" })).toEqual({
      ...closed,
      logoOpened: true,
    });
    expect(workAreaReducer(reopened, { type: "continued_to_directions" })).toEqual({
      ...closed,
      directionsOpened: true,
    });
  });

  it("opens a part of the chat from the bar; Identity also returns to its latest step", () => {
    const reopened = after({ type: "logo_link_arrived" }, { type: "reopened_step", step: "logo" });
    expect(
      workAreaReducer(reopened, { type: "section_requested", step: "strategy", stepOnScreen: "identity" }),
    ).toEqual({
      ...reopened,
      sectionViewed: "strategy",
    });
    expect(
      workAreaReducer(reopened, { type: "section_requested", step: "identity", stepOnScreen: "identity" }),
    ).toEqual(closed);
    expect(workAreaReducer(reopened, { type: "section_requested", step: "identity", stepOnScreen: "voice" })).toEqual({
      ...closed,
      sectionViewed: "identity",
    });
    // Asking for the step on screen clears an earlier request.
    const viewing = after({ type: "section_requested", step: "strategy", stepOnScreen: "voice" });
    expect(workAreaReducer(viewing, { type: "section_requested", step: "voice", stepOnScreen: "voice" })).toEqual(
      closed,
    );
    expect(workAreaReducer(viewing, { type: "viewed_section_on_screen" })).toEqual(closed);
  });

  it("returns the same state when an event changes nothing", () => {
    const events: WorkAreaEvent[] = [
      { type: "confirmed_name" },
      { type: "saved_name_changed" },
      { type: "closed_brief" },
      { type: "viewed_section_on_screen" },
      { type: "section_requested", step: "identity", stepOnScreen: "identity" },
    ];
    for (const event of events) expect(workAreaReducer(closed, event)).toBe(closed);
    const linked = after({ type: "logo_link_arrived" });
    expect(workAreaReducer(linked, { type: "logo_link_arrived" })).toBe(linked);
  });
});
