import { describe, expect, it } from "vitest";
import { homeStartView, type HomeStartSituation } from "@/components/workspace/home-start-permissions";

/** A signed-in person with a loaded, empty Home prompt and nothing under way. */
const ready: HomeStartSituation = {
  draftsLoaded: true,
  recoveryLoaded: true,
  hiddenPrompt: false,
  submitting: false,
  strategyPending: false,
  strategyLocked: false,
  strategyRecoveryBlocked: false,
  navigating: false,
  opening: false,
  signedIn: true,
  hasFiles: false,
  attachedSaveStarted: false,
  filesNeedAccount: false,
  selectingFiles: false,
  keptDraft: false,
  recoveryFull: false,
};
const keys = Object.keys(ready) as (keyof HomeStartSituation)[];
const view = (situation: Partial<HomeStartSituation> = {}) => homeStartView({ ...ready, ...situation });
const free = { editHeld: false, inputControlsHeld: false, sendHeld: false };
const allHeld = { editHeld: true, inputControlsHeld: true, sendHeld: true };

describe("what the person may do on the Home prompt", () => {
  it("lets a signed-in person with nothing under way edit and send", () => {
    expect(view()).toEqual(free);
  });

  it("holds everything until the device's projects and the kept prompt have been read", () => {
    expect(view({ draftsLoaded: false })).toEqual(allHeld);
    expect(view({ recoveryLoaded: false })).toEqual(allHeld);
  });

  it("holds everything while a send, a save, the router or an opening project is under way", () => {
    for (const busy of [
      { submitting: true },
      { strategyPending: true },
      { navigating: true },
      { opening: true },
    ] satisfies Partial<HomeStartSituation>[])
      expect(view(busy)).toEqual(allHeld);
  });

  it("holds everything for a prompt that belongs to another account, so Send is never a click that does nothing", () => {
    expect(view({ hiddenPrompt: true })).toEqual(allHeld);
  });

  it("holds everything while kept files wait for their account, signed out or no longer current", () => {
    expect(view({ filesNeedAccount: true })).toEqual(allHeld);
    expect(view({ filesNeedAccount: true, signedIn: false })).toEqual(allHeld);
  });

  it("holds everything when nobody is signed in and the device has no room to keep a prompt", () => {
    expect(view({ signedIn: false, recoveryFull: true })).toEqual(allHeld);
    // A copy already kept on this device, or an account, makes room.
    expect(view({ signedIn: false, recoveryFull: true, keptDraft: true })).toEqual(free);
    expect(view({ signedIn: true, recoveryFull: true })).toEqual(free);
  });

  it("keeps a prompt locked to an earlier save as it was, while Send repeats that save", () => {
    expect(view({ strategyLocked: true })).toEqual({ editHeld: true, inputControlsHeld: true, sendHeld: false });
    // Unless that save cannot be continued from here.
    expect(view({ strategyLocked: true, strategyRecoveryBlocked: true })).toEqual(allHeld);
  });

  it("freezes the brief of an attached save, while Send repeats it and the file controls keep their own way out", () => {
    expect(view({ hasFiles: true, attachedSaveStarted: true })).toEqual({
      editHeld: true,
      inputControlsHeld: false,
      sendHeld: false,
    });
  });

  it("holds only Send while a file picker is open: typed text is kept and the picker has its own Cancel", () => {
    expect(view({ selectingFiles: true })).toEqual({ editHeld: false, inputControlsHeld: false, sendHeld: true });
  });

  it("an earlier save that cannot be continued blocks sending typed text, not editing or an attached brief", () => {
    expect(view({ strategyRecoveryBlocked: true })).toEqual({
      editHeld: false,
      inputControlsHeld: false,
      sendHeld: true,
    });
    for (const attached of [{ hasFiles: true }, { attachedSaveStarted: true }] satisfies Partial<HomeStartSituation>[])
      expect(view({ strategyRecoveryBlocked: true, ...attached }).sendHeld).toBe(false);
  });

  it("answers every situation by the one rule", () => {
    for (let bits = 0; bits < 1 << keys.length; bits += 1) {
      const s = Object.fromEntries(keys.map((key, index) => [key, Boolean(bits & (1 << index))])) as HomeStartSituation;
      const held =
        !s.draftsLoaded ||
        !s.recoveryLoaded ||
        s.submitting ||
        s.strategyPending ||
        s.navigating ||
        s.opening ||
        s.hiddenPrompt ||
        s.filesNeedAccount ||
        (!s.signedIn && !s.keptDraft && s.recoveryFull);
      const actual = homeStartView(s);
      const expected = {
        editHeld: held || s.strategyLocked || s.attachedSaveStarted,
        inputControlsHeld: held || s.strategyLocked,
        sendHeld: held || s.selectingFiles || (s.strategyRecoveryBlocked && !s.hasFiles && !s.attachedSaveStarted),
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) expect({ s, actual }).toEqual({ s, actual: expected });
      // Whatever holds the controls holds the field, and nothing but a way to repeat a save (a locked
      // prompt, an attached save) or an open picker separates the field from Send.
      if (actual.inputControlsHeld) expect(actual.editHeld).toBe(true);
      if (actual.editHeld && !actual.sendHeld) expect(s.strategyLocked || s.attachedSaveStarted).toBe(true);
    }
  });
});
