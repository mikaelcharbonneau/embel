import { describe, expect, it } from "vitest";
import {
  journeyProgress,
  projectJourney,
  projectJourneyMark,
  type JourneyEvidence,
  type JourneyProgress,
} from "@/domain/journey";
import { getProjectHandoff } from "@/domain/project-handoff";
import { briefChangedSinceStrategy, revisitGuidedStage, strategyBrief } from "@/domain/guided-interview";
import { contextSnapshotSchema, type ContextSnapshot } from "@/domain/projects";

const id = "d0000000-0000-4000-8000-000000000002",
  base = `/brands/account/${id}`,
  now = "2026-11-14T00:00:00Z";
type Guided = NonNullable<ContextSnapshot["intake"]["guidedInterview"]>;
const brief = "A repairable lighting studio";

/** A conversation project with every Strategy answer and the Personality confirmed, at the Slogan question. */
function confirmed(stage: Guided["stage"] = "slogan"): ContextSnapshot {
  return contextSnapshotSchema.parse({
    description: brief,
    competitorReviewComplete: true,
    audienceSegments: [
      {
        id: "d0000000-0000-4000-8000-000000000003",
        label: "Small homes",
        needs: [],
        reason: "Compact lighting",
        selected: true,
        origin: "user",
      },
    ],
    personality: { sincerity: 60, excitement: 30, competence: 70, sophistication: 40, ruggedness: 20 },
    positioning: "Repairable lights for small homes",
    intake: {
      audienceReviewedAt: now,
      personalityReviewedAt: now,
      positioningReviewedAt: now,
      conversation: [{ id: "first", kind: "user_message", text: brief, createdAt: now }],
      guidedInterview: { version: 1, stage, turns: [], answers: [] },
    },
  });
}
const read = (context: ContextSnapshot, evidence?: JourneyEvidence | null) =>
  journeyProgress({ project: { id, scope: "complete_brand", context }, evidence });
const steps = (progress: JourneyProgress) => progress.steps.map((step) => `${step.id}:${step.status}`);
const parts = (progress: JourneyProgress, step: string) =>
  progress.steps.find((item) => item.id === step)!.parts.map((part) => `${part.label}:${part.status}`);
const none: JourneyEvidence = { logo: "none" };

describe("one answer to which steps are done, which is current and what is next", () => {
  it("starts at the brief: a project with no description cannot proceed", () => {
    const progress = read(contextSnapshotSchema.parse({}), none);
    expect(steps(progress)).toEqual(["strategy:current", "voice:upcoming", "identity:upcoming", "assets:upcoming"]);
    expect(progress.next).toEqual({
      step: "strategy",
      part: "Competitors",
      label: "Review the saved brief",
      href: `${base}?view=strategy#journey-strategy`,
      finished: false,
    });
    expect(progress.reviews[0]).toBe("brief");
    expect(progress.briefChanged).toBe(false);
  });

  it("walks Strategy one part at a time", () => {
    const context = confirmed("audience");
    context.intake.audienceReviewedAt = null;
    context.intake.positioningReviewedAt = null;
    context.intake.personalityReviewedAt = null;
    const progress = read(context, none);
    expect(parts(progress, "strategy")).toEqual(["Competitors:done", "Audience:current", "Positioning:upcoming"]);
    expect(parts(progress, "voice")).toEqual(["Personality:upcoming", "Name:upcoming", "Slogan:upcoming"]);
    expect(progress.next).toMatchObject({ step: "strategy", part: "Audience", label: "Review audience" });
    expect(progress.strategyReady).toBe(false);
  });

  it("keeps Positioning current while the conversation is still asking it", () => {
    const context = confirmed("positioning");
    context.intake.personalityReviewedAt = null;
    const progress = read(context, none);
    expect(parts(progress, "strategy")).toEqual(["Competitors:done", "Audience:done", "Positioning:current"]);
    expect(progress.next).toMatchObject({ step: "strategy", part: "Positioning", label: "Review positioning" });
  });

  it("files Personality under Voice, with Strategy done before it", () => {
    const context = confirmed("personality");
    context.intake.personalityReviewedAt = null;
    const progress = read(context, none);
    expect(steps(progress)).toEqual(["strategy:done", "voice:current", "identity:upcoming", "assets:upcoming"]);
    expect(parts(progress, "voice")).toEqual(["Personality:current", "Name:upcoming", "Slogan:upcoming"]);
    expect(progress.next).toEqual({
      step: "voice",
      part: "Personality",
      label: "Review personality",
      href: `${base}?view=strategy#journey-voice`,
      finished: false,
    });
    // The card mark and the bar read the same answer.
    expect(projectJourneyMark(progress.next!)).toEqual({
      states: ["complete", "current", "upcoming", "upcoming"],
      current: "voice",
    });
    expect(
      projectJourney({ projectId: id, pathname: base, progress }).map((step) => `${step.id}:${step.status}`),
    ).toEqual(["strategy:current", "voice:upcoming", "identity:upcoming", "assets:upcoming"]);
    expect(projectJourney({ projectId: id, pathname: base, progress })[0]).toMatchObject({ complete: true });
  });

  it("orders a project without a conversation by the journey, and links to a section that exists", () => {
    const legacy = () => {
      const context = confirmed();
      delete context.intake.guidedInterview;
      context.activity = "Lighting";
      context.offering = "Repairable lamps";
      context.reformulationConfirmed = true;
      return context;
    };
    const both = legacy();
    both.intake.personalityReviewedAt = null;
    both.intake.positioningReviewedAt = null;
    // Journey order: Positioning (Strategy) comes before Personality (Voice).
    expect(read(both, none).reviews).toEqual(["positioning", "personality"]);
    expect(read(both, none).next).toMatchObject({ step: "strategy", part: "Positioning" });
    // Without a conversation at Personality or later there is no Voice section to open.
    const personality = legacy();
    personality.intake.personalityReviewedAt = null;
    expect(read(personality, none).next).toMatchObject({
      step: "voice",
      part: "Personality",
      href: `${base}?view=strategy#journey-strategy`,
    });
  });

  it("goes to Name once Personality is confirmed, then to Slogan while the conversation still asks it", () => {
    const context = confirmed();
    expect(read(context, none).next).toEqual({
      step: "voice",
      part: "Name",
      label: "Continue to Naming",
      href: `${base}/naming`,
      finished: false,
    });
    context.selectedName = "Luma";
    const progress = read(context, none);
    expect(parts(progress, "voice")).toEqual(["Personality:done", "Name:done", "Slogan:current"]);
    expect(steps(progress)).toEqual(["strategy:done", "voice:current", "identity:upcoming", "assets:upcoming"]);
    expect(progress.next).toEqual({
      step: "voice",
      part: "Slogan",
      label: "Continue to Slogan",
      href: `${base}?view=strategy#journey-voice`,
      finished: false,
    });
  });

  it("counts a skipped slogan, a chosen slogan and a closed conversation as done", () => {
    const answered = (customText: string | null) => {
      const context = confirmed("complete");
      context.selectedName = "Luma";
      context.intake.guidedInterview = {
        version: 1,
        stage: "complete",
        turns: [{ id: "t", userMessageId: null, stage: "slogan", purpose: "propose", inputRevision: 2 }],
        answers: [{ stage: "slogan", turnId: "t", optionIds: [], customText, confirmedAt: now }],
      };
      return contextSnapshotSchema.parse(context);
    };
    const closed = confirmed("complete");
    closed.selectedName = "Luma";
    for (const context of [answered(null), answered("Light that lasts"), closed]) {
      const progress = read(context, none);
      expect(parts(progress, "voice")).toEqual(["Personality:done", "Name:done", "Slogan:done"]);
      expect(steps(progress)).toEqual(["strategy:done", "voice:done", "identity:current", "assets:upcoming"]);
      expect(progress.next).toEqual({
        step: "identity",
        part: "Inspiration",
        label: "Continue to Inspiration",
        href: `${base}/inspiration`,
        finished: false,
      });
    }
  });

  it("does not ask a project without a conversation for a slogan", () => {
    const context = confirmed();
    delete context.intake.guidedInterview;
    context.activity = "Lighting";
    context.offering = "Repairable lamps";
    context.reformulationConfirmed = true;
    context.selectedName = "Luma";
    expect(read(context, none).next).toMatchObject({ step: "identity", part: "Inspiration" });
  });

  it.each([
    [{ logo: "started" }, "Logo", "Continue logo design", "/logo"],
    [{ logo: "progress" }, "Logo", "Review logo progress", "/logo"],
    [{ logo: "choose" }, "Logo", "Choose a logo", "/logo"],
    [
      { logo: "chosen", brandKit: false, directions: 0, directionsPending: false },
      "Creative direction",
      "Explore creative directions",
      "/logo/directions",
    ],
    [
      { logo: "chosen", brandKit: false, directions: 0, directionsPending: true },
      "Creative direction",
      "Check direction progress",
      "/logo/directions",
    ],
    [
      { logo: "chosen", brandKit: false, directions: 1, directionsPending: false },
      "Creative direction",
      "Review visual direction",
      "/logo/directions",
    ],
    [
      { logo: "chosen", brandKit: false, directions: 3, directionsPending: true },
      "Creative direction",
      "Compare 3 directions",
      "/logo/directions",
    ],
  ] as const)("reads Identity from the saved logo and direction work: %j", (evidence, part, label, path) => {
    const context = confirmed("complete");
    context.selectedName = "Luma";
    const progress = read(context, evidence);
    expect(steps(progress)).toEqual(["strategy:done", "voice:done", "identity:current", "assets:upcoming"]);
    expect(progress.next).toEqual({ step: "identity", part, label, href: `${base}${path}`, finished: false });
    expect(parts(progress, "identity").filter((item) => item.endsWith(":current"))).toEqual([`${part}:current`]);
  });

  it("lets started logo work lead, as the cards always did, even when an earlier step is open again", () => {
    const context = confirmed("personality");
    context.intake.personalityReviewedAt = null;
    const progress = read(context, { logo: "choose" });
    expect(steps(progress)).toEqual(["strategy:done", "voice:done", "identity:current", "assets:upcoming"]);
    expect(progress.next).toMatchObject({ label: "Choose a logo" });
    expect(progress.reviews).toEqual(["personality"]);
  });

  it("is finished once the brand kit exists: every step is done on the card and on the bar", () => {
    const context = confirmed("complete");
    context.selectedName = "Luma";
    const progress = read(context, { logo: "chosen", brandKit: true });
    expect(progress.finished).toBe(true);
    expect(steps(progress)).toEqual(["strategy:done", "voice:done", "identity:done", "assets:done"]);
    expect(progress.next).toEqual({
      step: "assets",
      part: "Brand images",
      label: "View brand kit",
      href: `${base}/logo/deliverables`,
      finished: true,
    });
    expect(projectJourneyMark(progress.next!)).toEqual({
      states: ["complete", "complete", "complete", "complete"],
      current: null,
    });
    expect(
      projectJourney({ projectId: id, pathname: `${base}/logo`, progress }).map(
        (step) => `${step.id}:${step.status}${step.href ? `->${step.href.replace(base, "")}` : ""}`,
      ),
    ).toEqual([
      "strategy:done->?view=strategy",
      "voice:done->/naming",
      "identity:current->/logo",
      "assets:done->/logo/deliverables",
    ]);
  });

  it("claims only what the saved answers prove while the logo work has not been read", () => {
    const context = confirmed("complete");
    context.selectedName = "Luma";
    const unread = read(context);
    expect(steps(unread)).toEqual(["strategy:done", "voice:done", "identity:upcoming", "assets:upcoming"]);
    expect(unread.next).toBeNull();
    const early = confirmed("audience");
    early.intake.audienceReviewedAt = null;
    const earlyUnread = read(early);
    expect(parts(earlyUnread, "strategy")).toEqual(["Competitors:done", "Audience:upcoming", "Positioning:upcoming"]);
    expect(earlyUnread.next).toBeNull();
    expect(projectJourneyMark(null)).toBeNull();
  });

  it("gives the handoff the same next step", () => {
    const context = confirmed();
    context.selectedName = "Luma";
    const handoff = getProjectHandoff({ id, scope: "complete_brand", context });
    expect(handoff.next).toEqual(read(context, none).next);
    expect(handoff).toMatchObject({ savedName: "Luma", strategyReady: true, reviews: [] });
  });
});

describe("a brief edited after Strategy was confirmed", () => {
  const edited = () => {
    const context = confirmed();
    context.selectedName = "Luma";
    context.description = "A repairable lighting studio for renters";
    return context;
  };

  it("keeps every step done and only reports that the brief changed", () => {
    const context = edited();
    expect(strategyBrief(context)).toBe(brief);
    expect(briefChangedSinceStrategy(context)).toBe(true);
    const progress = read(context, none);
    expect(progress.briefChanged).toBe(true);
    expect(progress.strategyReady).toBe(true);
    expect(progress.reviews).toEqual([]);
    expect(progress.next).toMatchObject({ step: "voice", part: "Slogan" });
    expect(read(confirmed(), none).briefChanged).toBe(false);
  });

  it("does not call an emptied brief an edited one: it cannot proceed, as before", () => {
    const context = edited();
    context.description = "";
    expect(briefChangedSinceStrategy(context)).toBe(false);
    const progress = read(context, none);
    expect(progress.briefChanged).toBe(false);
    expect(progress.next).toMatchObject({ step: "strategy", label: "Review the saved brief" });
  });

  it("says nothing before the first Strategy answer, or when the first brief is unknown", () => {
    const early = edited();
    early.competitorReviewComplete = false;
    expect(briefChangedSinceStrategy(early)).toBe(false);
    const unknown = edited();
    unknown.intake.conversation = [];
    expect(strategyBrief(unknown)).toBeNull();
    expect(briefChangedSinceStrategy(unknown)).toBe(false);
  });

  it("stops reporting it once Strategy is redone from its first step, which records the brief it starts from", () => {
    const redone = revisitGuidedStage(edited(), "competitors");
    expect(redone.intake.conversation).toEqual([
      { id: "strategy-brief", kind: "saved_context", text: "A repairable lighting studio for renters" },
      { id: "first", kind: "user_message", text: brief, createdAt: now },
    ]);
    expect(strategyBrief(redone)).toBe("A repairable lighting studio for renters");
    // Once the first step is confirmed again, nothing is reported for this brief.
    const again = contextSnapshotSchema.parse({ ...redone, competitorReviewComplete: true });
    expect(briefChangedSinceStrategy(again)).toBe(false);
    // A later edit is reported again, and a later redo replaces the recorded brief instead of adding one.
    const later = contextSnapshotSchema.parse({ ...again, description: "A lighting studio for renters and hosts" });
    expect(briefChangedSinceStrategy(later)).toBe(true);
    const twice = revisitGuidedStage(later, "competitors");
    expect(twice.intake.conversation?.filter((event) => event.kind === "saved_context")).toEqual([
      { id: "strategy-brief", kind: "saved_context", text: "A lighting studio for renters and hosts" },
    ]);
  });

  it("leaves the conversation alone when the brief did not change, and when a later step is reopened", () => {
    expect(revisitGuidedStage(confirmed(), "competitors").intake.conversation).toEqual(confirmed().intake.conversation);
    expect(revisitGuidedStage(edited(), "audience").intake.conversation).toEqual(edited().intake.conversation);
  });
});
