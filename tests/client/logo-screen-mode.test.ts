import { describe, expect, it } from "vitest";
import {
  LOGO_SCREEN_START,
  logoScreenReducer,
  type LogoScreenEvent,
  type LogoScreenMode,
} from "@/components/logo-creation/logo-screen-mode";

// The Logo screen's own modes (docs/state-machines.md, S2): one reducer, events named after what happened.
const after = (...events: LogoScreenEvent[]): LogoScreenMode => events.reduce(logoScreenReducer, LOGO_SCREEN_START);
const concept = { kind: "concept", batchId: "batch", slotId: "slot", attemptId: "attempt" } as never;

describe("the Logo screen's modes", () => {
  it("starts with nothing open and nothing out", () => {
    expect(LOGO_SCREEN_START).toEqual({
      choiceSaving: false,
      choosing: null,
      ranOut: null,
      changingTypes: false,
      confirmingDiscard: false,
      checkingSave: false,
    });
  });

  it("shows a clicked concept as chosen while its save is out, and takes it back when the save ends", () => {
    const started = after({ type: "choice_started", source: concept });
    expect(started).toMatchObject({ choiceSaving: true, choosing: concept });
    expect(logoScreenReducer(started, { type: "choice_ended", current: true })).toEqual(LOGO_SCREEN_START);
  });

  it("checks or retries an unconfirmed choice without marking a card", () => {
    expect(after({ type: "choice_started", source: null })).toMatchObject({ choiceSaving: true, choosing: null });
  });

  it("keeps saving on when the request ended for another account, but still lets the card go back", () => {
    expect(after({ type: "choice_started", source: concept }, { type: "choice_ended", current: false })).toMatchObject({
      choiceSaving: true,
      choosing: null,
    });
  });

  it("puts the out-of-credits message at the refused control until it is dismissed or a new request is sent", () => {
    for (const control of ["concepts", "refine"] as const) {
      const refused = after({ type: "start_asked" }, { type: "credits_refused", control });
      expect(refused.ranOut).toBe(control);
      expect(logoScreenReducer(refused, { type: "credits_message_dismissed" }).ranOut).toBeNull();
      expect(logoScreenReducer(refused, { type: "start_asked" }).ranOut).toBeNull();
    }
    expect(
      after({ type: "credits_refused", control: "concepts" }, { type: "credits_refused", control: "refine" }).ranOut,
    ).toBe("refine");
  });

  it("opens and closes the logo types, the discard confirmation and the save check", () => {
    expect(after({ type: "types_change_opened" }).changingTypes).toBe(true);
    expect(after({ type: "types_change_opened" }, { type: "types_change_done" }).changingTypes).toBe(false);
    expect(after({ type: "discard_asked" }).confirmingDiscard).toBe(true);
    expect(after({ type: "discard_asked" }, { type: "discard_answered" }).confirmingDiscard).toBe(false);
    expect(after({ type: "save_check_started" }).checkingSave).toBe(true);
    expect(after({ type: "save_check_started" }, { type: "save_check_ended" }).checkingSave).toBe(false);
  });

  it("changes only its own mode", () => {
    const busy = after(
      { type: "choice_started", source: concept },
      { type: "credits_refused", control: "refine" },
      { type: "types_change_opened" },
      { type: "discard_asked" },
      { type: "save_check_started" },
    );
    expect(busy).toEqual({
      choiceSaving: true,
      choosing: concept,
      ranOut: "refine",
      changingTypes: true,
      confirmingDiscard: true,
      checkingSave: true,
    });
    expect(logoScreenReducer(busy, { type: "types_change_done" })).toEqual({ ...busy, changingTypes: false });
    expect(logoScreenReducer(busy, { type: "start_asked" })).toEqual({ ...busy, ranOut: null });
  });

  it("returns the same object for an event that changes nothing, so the screen does not render again", () => {
    for (const event of [
      { type: "start_asked" },
      { type: "credits_message_dismissed" },
      { type: "types_change_done" },
      { type: "discard_answered" },
      { type: "save_check_ended" },
      { type: "choice_ended", current: true },
      { type: "choice_ended", current: false },
    ] as const)
      expect(logoScreenReducer(LOGO_SCREEN_START, event), event.type).toBe(LOGO_SCREEN_START);
  });
});
