import { describe, expect, it } from "vitest";
import {
  homeStartView,
  type HomeStartNow,
  type HomeStartSituation,
} from "@/components/workspace/home-start-permissions";

type Shown = Omit<HomeStartSituation, "now">;
const shownKeys = [
  "draftsLoaded",
  "recoveryLoaded",
  "hiddenPrompt",
  "submitting",
  "strategyPending",
  "strategyLocked",
  "strategyRecoveryBlocked",
  "navigating",
  "opening",
  "signedIn",
  "hasFiles",
  "frozenBrief",
  "hiddenFiles",
  "selectingFiles",
  "keptDraft",
  "recoveryFull",
] as const satisfies readonly (keyof Shown)[];
const nowKeys = [
  "submitting",
  "filesNeedAccount",
  "attachedSaveStarted",
] as const satisfies readonly (keyof HomeStartNow)[];

/** A signed-in person with a loaded, empty Home prompt and nothing under way. */
const ready: Shown = {
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
  frozenBrief: false,
  hiddenFiles: false,
  selectingFiles: false,
  keptDraft: false,
  recoveryFull: false,
};
const idle: HomeStartNow = { submitting: false, filesNeedAccount: false, attachedSaveStarted: false };
const view = (shown: Partial<Shown> = {}, now: Partial<HomeStartNow> | null = {}) =>
  homeStartView({ ...ready, ...shown, now: now && { ...idle, ...now } });

// The four computations as `project-editor.tsx` wrote them before `homeStartView`, and the file
// controls' own line. Transcribed, not imported: this is the proof that nothing moved.
function before(s: Shown, now: HomeStartNow) {
  const textRecoveryBlocked = s.strategyRecoveryBlocked && !s.hasFiles && !s.frozenBrief;
  const frozenInputs =
    !s.recoveryLoaded ||
    s.hiddenPrompt ||
    s.submitting ||
    s.strategyPending ||
    s.strategyLocked ||
    s.navigating ||
    s.opening ||
    s.frozenBrief ||
    s.hiddenFiles;
  const disabled =
    !s.draftsLoaded ||
    !s.recoveryLoaded ||
    textRecoveryBlocked ||
    (!s.signedIn && !s.keptDraft && s.recoveryFull) ||
    s.submitting ||
    s.strategyPending ||
    s.navigating ||
    s.opening ||
    s.hiddenFiles ||
    s.selectingFiles;
  function canEditInputs() {
    if (s.hiddenPrompt) return false;
    if (!s.recoveryLoaded || now.submitting || s.strategyPending || s.strategyLocked || s.navigating || s.opening)
      return false;
    if (now.filesNeedAccount) return false;
    return !now.attachedSaveStarted;
  }
  function sendGoesOn() {
    if (
      !s.recoveryLoaded ||
      s.hiddenPrompt ||
      now.submitting ||
      s.navigating ||
      s.opening ||
      s.strategyPending ||
      textRecoveryBlocked
    )
      return false;
    return true;
  }
  return {
    readOnly: frozenInputs,
    sendDisabled: disabled,
    inputControlsDisabled: !s.recoveryLoaded || s.submitting || s.navigating || s.strategyPending || s.strategyLocked,
    mayEdit: canEditInputs(),
    maySend: sendGoesOn(),
  };
}

describe("what the person may do on the Home prompt", () => {
  it("answers every situation exactly as the four places did before", () => {
    let checked = 0;
    for (let bits = 0; bits < 1 << shownKeys.length; bits += 1) {
      const shown = Object.fromEntries(shownKeys.map((key, index) => [key, Boolean(bits & (1 << index))])) as Shown;
      for (let nowBits = 0; nowBits < 1 << nowKeys.length; nowBits += 1) {
        const now = Object.fromEntries(
          nowKeys.map((key, index) => [key, Boolean(nowBits & (1 << index))]),
        ) as HomeStartNow;
        const actual = homeStartView({ ...shown, now });
        const expected = before(shown, now);
        if (
          actual.readOnly !== expected.readOnly ||
          actual.sendDisabled !== expected.sendDisabled ||
          actual.inputControlsDisabled !== expected.inputControlsDisabled ||
          actual.mayEdit !== expected.mayEdit ||
          actual.maySend !== expected.maySend
        )
          expect({ shown, now, actual }).toEqual({ shown, now, actual: expected });
        checked += 1;
      }
    }
    expect(checked).toBe(2 ** 19);
  });

  it("lets a signed-in person with nothing under way edit and send", () => {
    expect(view()).toEqual({
      readOnly: false,
      sendDisabled: false,
      inputControlsDisabled: false,
      mayEdit: true,
      maySend: true,
    });
  });

  it("answers no click while rendering", () => {
    expect(view({}, null)).toMatchObject({ readOnly: false, sendDisabled: false, mayEdit: false, maySend: false });
  });

  it("holds everything until the kept prompt has been looked for", () => {
    expect(view({ recoveryLoaded: false })).toEqual({
      readOnly: true,
      sendDisabled: true,
      inputControlsDisabled: true,
      mayEdit: false,
      maySend: false,
    });
  });

  it("holds everything while a send, a save, the router or an opening project is under way", () => {
    for (const busy of [{ strategyPending: true }, { navigating: true }, { opening: true }] satisfies Partial<Shown>[])
      expect(view(busy)).toMatchObject({ readOnly: true, sendDisabled: true, mayEdit: false, maySend: false });
    expect(view({ submitting: true }, { submitting: true })).toEqual({
      readOnly: true,
      sendDisabled: true,
      inputControlsDisabled: true,
      mayEdit: false,
      maySend: false,
    });
  });

  it("refuses a second click before the first send is rendered", () => {
    // The guard ref is ahead of the rendered flag: the screen still looks free, the click is refused.
    expect(view({ submitting: false }, { submitting: true })).toEqual({
      readOnly: false,
      sendDisabled: false,
      inputControlsDisabled: false,
      mayEdit: false,
      maySend: false,
    });
  });

  // THE FOUR PLACES DO NOT AGREE. Every case below is today's behavior, preserved on purpose when the
  // four computations were moved into one function (docs/state-machines.md, rule 5). Each is a
  // candidate fix for a later change; change the function and this test together.
  describe("differences preserved on purpose", () => {
    it("an attached save without a frozen project: the field looks editable, edits are ignored", () => {
      // The read-only answer tests `saveIntent.project`; the edit answer tests `saveIntent`.
      expect(view({ frozenBrief: false }, { attachedSaveStarted: true })).toMatchObject({
        readOnly: false,
        mayEdit: false,
      });
      expect(view({ frozenBrief: true }, { attachedSaveStarted: true })).toMatchObject({
        readOnly: true,
        mayEdit: false,
      });
    });

    it("kept files whose account is no longer current: the field looks editable, edits are ignored", () => {
      // The read-only answer only knows "nobody is signed in"; the edit answer also checks the session.
      expect(view({ hiddenFiles: false }, { filesNeedAccount: true })).toMatchObject({
        readOnly: false,
        sendDisabled: false,
        mayEdit: false,
        maySend: true,
      });
    });

    it("kept files and nobody signed in: Send is disabled, yet a send would go past its first check", () => {
      expect(view({ signedIn: false, hiddenFiles: true }, { filesNeedAccount: true })).toMatchObject({
        readOnly: true,
        sendDisabled: true,
        mayEdit: false,
        maySend: true,
      });
    });

    it("a prompt that belongs to another account: Send stays enabled and does nothing", () => {
      expect(view({ hiddenPrompt: true })).toEqual({
        readOnly: true,
        sendDisabled: false,
        inputControlsDisabled: false,
        mayEdit: false,
        maySend: false,
      });
    });

    it("a prompt locked to an earlier save: read-only, but Send and the send check ignore the lock", () => {
      expect(view({ strategyLocked: true })).toEqual({
        readOnly: true,
        sendDisabled: false,
        inputControlsDisabled: true,
        mayEdit: false,
        maySend: true,
      });
    });

    it("a frozen attached brief: read-only, while the file controls stay enabled", () => {
      expect(view({ hasFiles: true, frozenBrief: true }, { attachedSaveStarted: true })).toEqual({
        readOnly: true,
        sendDisabled: false,
        inputControlsDisabled: false,
        mayEdit: false,
        maySend: true,
      });
    });

    it("an opening project: everything is held except the file controls", () => {
      expect(view({ opening: true })).toMatchObject({
        readOnly: true,
        sendDisabled: true,
        inputControlsDisabled: false,
      });
    });

    it("device drafts not read yet, an open file picker, a full device: only Send is disabled", () => {
      for (const only of [
        { draftsLoaded: false },
        { selectingFiles: true },
        { signedIn: false, recoveryFull: true },
      ] satisfies Partial<Shown>[])
        expect(view(only)).toEqual({
          readOnly: false,
          sendDisabled: true,
          inputControlsDisabled: false,
          mayEdit: true,
          maySend: true,
        });
      // A copy already kept on this device, or an account, makes room.
      expect(view({ signedIn: false, recoveryFull: true, keptDraft: true }).sendDisabled).toBe(false);
      expect(view({ signedIn: true, recoveryFull: true }).sendDisabled).toBe(false);
    });

    it("an earlier save that cannot be continued blocks sending typed text, not editing or files", () => {
      expect(view({ strategyRecoveryBlocked: true })).toEqual({
        readOnly: false,
        sendDisabled: true,
        inputControlsDisabled: false,
        mayEdit: true,
        maySend: false,
      });
      for (const attached of [{ hasFiles: true }, { frozenBrief: true }] satisfies Partial<Shown>[])
        expect(view({ strategyRecoveryBlocked: true, ...attached })).toMatchObject({
          sendDisabled: false,
          maySend: true,
        });
    });
  });
});
