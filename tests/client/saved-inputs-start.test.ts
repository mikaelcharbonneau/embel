import { describe, expect, it } from "vitest";
import {
  savedInputsStart,
  type LogoSavedInputStatus,
  type SavedInputsStartSituation,
} from "@/components/logo-creation/saved-inputs-controller";

// When work on the Logo screen's saved inputs starts (docs/state-machines.md, S6). Each rule is compared, over
// every combination of its inputs, with the condition its effect carried before the decision was moved here.
const statuses: LogoSavedInputStatus[] = ["idle", "reading", "saving", "prepared", "blocked", "checked", "obsolete"];
const flags = [false, true];
const busyOf = (status: LogoSavedInputStatus) => status === "reading" || status === "saving";
type Of<T extends SavedInputsStartSituation["trigger"]> = Extract<SavedInputsStartSituation, { trigger: T }>;

describe("new likes, before the first concepts", () => {
  const start: Of<"likes_changed"> = {
    trigger: "likes_changed",
    likes: "likes-2",
    seenLikes: "likes-1",
    conceptsExist: false,
    conceptsLoading: false,
    busy: false,
    status: "idle",
  };

  it("refreshes the brief for likes that changed since they were last seen", () => {
    expect(savedInputsStart(start)).toEqual({ start: "refresh" });
  });

  it.each([
    ["Inspiration has not loaded", { likes: null }, "likes_unchanged"],
    ["Inspiration has not loaded and nothing was seen", { likes: null, seenLikes: null }, "likes_unchanged"],
    ["the likes are the ones already seen", { seenLikes: "likes-2" }, "likes_unchanged"],
    ["it is the first reading", { seenLikes: null }, "first_likes_reading"],
    ["the first reading wins over concepts", { seenLikes: null, conceptsExist: true }, "first_likes_reading"],
    ["concepts exist", { conceptsExist: true }, "concepts_exist"],
    ["concepts exist and are loading", { conceptsExist: true, conceptsLoading: true }, "concepts_exist"],
    ["concepts are loading", { conceptsLoading: true }, "concepts_loading"],
    ["the inputs are being read", { busy: true, status: "reading" }, "busy"],
    ["the inputs are being saved", { busy: true, status: "saving" }, "busy"],
    ["a comparison answered", { status: "checked" }, "status_holds"],
    ["the last answer was obsolete", { status: "obsolete" }, "status_holds"],
  ] as const)("does not start when %s", (_name, change, why) => {
    expect(savedInputsStart({ ...start, ...change })).toEqual({ start: null, why });
  });

  it.each(["idle", "prepared", "blocked"] as const)("starts from %s", (status) => {
    expect(savedInputsStart({ ...start, status })).toEqual({ start: "refresh" });
  });

  it("agrees with the effect's former condition for every input", () => {
    for (const likes of [null, "a", "b"])
      for (const seenLikes of [null, "a", "b"])
        for (const conceptsExist of flags)
          for (const conceptsLoading of flags)
            for (const status of statuses) {
              const busy = busyOf(status);
              const former =
                likes === null || likes === seenLikes
                  ? "nothing"
                  : seenLikes === null
                    ? "remember"
                    : conceptsExist || conceptsLoading || busy || !["idle", "prepared", "blocked"].includes(status)
                      ? "nothing"
                      : "start";
              const decision = savedInputsStart({
                trigger: "likes_changed",
                likes,
                seenLikes,
                conceptsExist,
                conceptsLoading,
                busy,
                status,
              });
              const now =
                decision.start === "refresh"
                  ? "start"
                  : decision.start === null && decision.why === "first_likes_reading"
                    ? "remember"
                    : "nothing";
              expect(decision.start === null || decision.start === "refresh").toBe(true);
              expect(now).toBe(former);
            }
  });
});

describe("new saved heads", () => {
  const start: Of<"saved_heads"> = {
    trigger: "saved_heads",
    headsKey: "heads-2",
    preparedKey: "heads-1",
    canPrepare: true,
    conceptsExist: false,
    conceptsLoading: false,
    conceptsUnavailable: false,
    status: "idle",
  };

  it("prepares heads that were not prepared yet", () => {
    expect(savedInputsStart(start)).toEqual({ start: "prepare" });
    expect(savedInputsStart({ ...start, preparedKey: null, status: "prepared" })).toEqual({ start: "prepare" });
  });

  it.each([
    ["nothing is saved", { headsKey: null }, "nothing_saved"],
    ["the brief cannot be prepared now", { canPrepare: false }, "cannot_prepare"],
    ["nothing is saved, whatever else holds", { headsKey: null, canPrepare: false }, "nothing_saved"],
    ["concepts exist", { conceptsExist: true }, "concepts_exist"],
    ["concepts are loading", { conceptsLoading: true }, "concepts_loading"],
    ["concepts could not be read", { conceptsUnavailable: true }, "concepts_unavailable"],
    ["the inputs are being read", { status: "reading" }, "busy"],
    ["the inputs are being saved", { status: "saving" }, "busy"],
    ["a blocker is showing", { status: "blocked" }, "status_holds"],
    ["a comparison answered", { status: "checked" }, "status_holds"],
    ["the last answer was obsolete", { status: "obsolete" }, "status_holds"],
    ["these heads were already prepared", { preparedKey: "heads-2" }, "already_prepared"],
  ] as const)("does not start when %s", (_name, change, why) => {
    expect(savedInputsStart({ ...start, ...change })).toEqual({ start: null, why });
  });

  it("agrees with the effect's former condition for every input", () => {
    for (const headsKey of [null, "a", "b"])
      for (const preparedKey of [null, "a", "b"])
        for (const canPrepare of flags)
          for (const conceptsExist of flags)
            for (const conceptsLoading of flags)
              for (const conceptsUnavailable of flags)
                for (const status of statuses) {
                  const held =
                    !headsKey ||
                    !canPrepare ||
                    conceptsExist ||
                    conceptsLoading ||
                    conceptsUnavailable ||
                    !["idle", "prepared"].includes(status) ||
                    preparedKey === headsKey;
                  const decision = savedInputsStart({
                    trigger: "saved_heads",
                    headsKey,
                    preparedKey,
                    canPrepare,
                    conceptsExist,
                    conceptsLoading,
                    conceptsUnavailable,
                    status,
                  });
                  expect(decision.start).toBe(held ? null : "prepare");
                }
  });
});

describe("comparing the brief with newer likes once concepts exist", () => {
  const start: Of<"likes_check"> = { trigger: "likes_check", checkKey: "likes|heads", checkedKey: null, busy: false };

  it("compares a key that has not answered yet", () => {
    expect(savedInputsStart(start)).toEqual({ start: "check" });
    expect(savedInputsStart({ ...start, checkedKey: "older|heads" })).toEqual({ start: "check" });
  });

  it.each([
    ["there are no concepts or nothing is saved", { checkKey: null }, "nothing_to_check"],
    ["this key already answered", { checkedKey: "likes|heads" }, "already_checked"],
    ["the inputs are being read or saved", { busy: true }, "busy"],
    ["this key already answered, even while busy", { checkedKey: "likes|heads", busy: true }, "already_checked"],
  ] as const)("does not start when %s", (_name, change, why) => {
    expect(savedInputsStart({ ...start, ...change })).toEqual({ start: null, why });
  });

  it("agrees with the effect's former condition for every input", () => {
    for (const checkKey of [null, "a", "b"])
      for (const checkedKey of [null, "a", "b"])
        for (const busy of flags) {
          const held = !checkKey || checkedKey === checkKey || busy;
          expect(savedInputsStart({ trigger: "likes_check", checkKey, checkedKey, busy }).start).toBe(
            held ? null : "check",
          );
        }
  });
});
