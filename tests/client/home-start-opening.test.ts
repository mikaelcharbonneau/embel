import { describe, expect, it } from "vitest";
import {
  homeStartOpeningReducer,
  initialHomeStartOpening,
  type HomeStartOpeningEvent,
  type HomeStartOpeningState,
} from "@/components/workspace/home-start-opening";

const me = "owner-1:1";
const other = "owner-2:4";
const run = (state: HomeStartOpeningState, ...events: HomeStartOpeningEvent[]) =>
  events.reduce(homeStartOpeningReducer, state);
const saving = run(initialHomeStartOpening, { type: "save_started", identity: me, showOpening: true });

describe("saving, then opening the project, from the Home prompt", () => {
  it("starts with nothing to say", () => {
    expect(initialHomeStartOpening).toEqual({ action: null, opening: null, destination: null });
  });

  it("an availability check shows its words and holds nothing", () => {
    const checking = run(initialHomeStartOpening, {
      type: "availability_check_started",
      identity: me,
      message: "Checking",
    });
    expect(checking).toEqual({
      action: { identity: me, pending: false, message: "Checking" },
      opening: null,
      destination: null,
    });
    expect(run(checking, { type: "availability_check_finished", identity: me, message: "Ready" }).action).toEqual({
      identity: me,
      pending: false,
      message: "Ready",
    });
  });

  it("a save is pending and, on the guided Home, replaces the form with the opening view", () => {
    expect(saving).toEqual({
      action: { identity: me, pending: true, message: "Saving your project…" },
      opening: me,
      destination: null,
    });
  });

  it("a plain save outside the guided Home is pending without the opening view", () => {
    expect(run(initialHomeStartOpening, { type: "save_started", identity: me, showOpening: false })).toEqual({
      action: { identity: me, pending: true, message: "Saving your project…" },
      opening: null,
      destination: null,
    });
    // It leaves an earlier opening mark as it was.
    expect(
      run({ ...initialHomeStartOpening, opening: other }, { type: "save_started", identity: me, showOpening: false })
        .opening,
    ).toBe(other);
  });

  it("a saved project stays pending while it opens", () => {
    expect(run(saving, { type: "project_opening", identity: me, href: "/projects/p1" })).toEqual({
      action: { identity: me, pending: true, message: "Project saved. Opening your project…" },
      opening: me,
      destination: { identity: me, href: "/projects/p1" },
    });
  });

  it("a refused navigation drops only the destination; the save's failure and ending follow", () => {
    const opened = run(saving, { type: "project_opening", identity: me, href: "/projects/p1" });
    const refused = run(opened, { type: "project_open_failed" });
    expect(refused).toEqual({ ...opened, destination: null });
    expect(
      run(
        refused,
        { type: "save_failed", identity: me, message: "Not confirmed" },
        { type: "save_settled", identity: me },
      ),
    ).toEqual({ action: { identity: me, pending: false, message: "Not confirmed" }, opening: null, destination: null });
  });

  it("a save that ends without a project stops being pending and keeps its words", () => {
    expect(run(saving, { type: "save_settled", identity: me })).toEqual({
      action: { identity: me, pending: false, message: "Saving your project…" },
      opening: null,
      destination: null,
    });
  });

  it("an ending save leaves another account session's notice alone", () => {
    const theirs = run(initialHomeStartOpening, { type: "save_started", identity: other, showOpening: true });
    expect(run(theirs, { type: "save_settled", identity: me })).toEqual({ ...theirs, opening: null });
    expect(run(initialHomeStartOpening, { type: "save_settled", identity: me })).toEqual(initialHomeStartOpening);
  });

  it("a new prompt clears the notice and the opening view, not a destination", () => {
    const opened = run(saving, { type: "project_opening", identity: me, href: "/projects/p1" });
    expect(run(opened, { type: "prompt_detached" })).toEqual({
      action: null,
      opening: null,
      destination: opened.destination,
    });
    expect(homeStartOpeningReducer(initialHomeStartOpening, { type: "prompt_detached" })).toBe(initialHomeStartOpening);
  });
});
