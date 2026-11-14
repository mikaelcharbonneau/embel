import { describe, expect, it } from "vitest";
import {
  homeStartFormReducer,
  initialHomeStartForm,
  type HomeStartFormEvent,
  type HomeStartFormState,
} from "@/components/workspace/home-start-form-state";

const run = (state: HomeStartFormState, ...events: HomeStartFormEvent[]) => events.reduce(homeStartFormReducer, state);
const fresh = initialHomeStartForm(false);
/** A restored, locked example prompt owned by an account, with a send under way and a project opening. */
const full: HomeStartFormState = {
  recoveryLoaded: true,
  resumedPrompt: true,
  recoveryLocked: true,
  textDraftId: "draft-1",
  promptOwner: "owner-1",
  exampleUsed: true,
  submitting: true,
  opening: { fence: "owner-1:1", href: "/projects/p1" },
};

describe("the Home prompt form's mode", () => {
  it("starts with nothing loaded, and remembers an example opened by link", () => {
    expect(fresh).toEqual({
      recoveryLoaded: false,
      resumedPrompt: false,
      recoveryLocked: false,
      textDraftId: null,
      promptOwner: null,
      exampleUsed: false,
      submitting: false,
      opening: null,
    });
    expect(initialHomeStartForm(true)).toEqual({ ...fresh, exampleUsed: true });
  });

  it("marks the kept prompt as looked for, with or without one found", () => {
    expect(run(fresh, { type: "recovery_checked" })).toEqual({ ...fresh, recoveryLoaded: true });
  });

  it("puts a kept prompt back with its lock, owner and example mark", () => {
    expect(
      run(
        fresh,
        { type: "recovery_checked" },
        { type: "prompt_restored", draftId: "draft-1", locked: true, ownerId: "owner-1", example: true },
      ),
    ).toEqual({
      ...fresh,
      recoveryLoaded: true,
      resumedPrompt: true,
      recoveryLocked: true,
      textDraftId: "draft-1",
      promptOwner: "owner-1",
      exampleUsed: true,
    });
  });

  it("gives a typed prompt to whoever is signed in, and to nobody when signed out", () => {
    expect(run(fresh, { type: "prompt_edited", ownerId: "owner-1" })).toEqual({ ...fresh, promptOwner: "owner-1" });
    expect(run(full, { type: "prompt_edited", ownerId: null })).toEqual({ ...full, promptOwner: null });
  });

  it("marks an example without changing the owner", () => {
    expect(run({ ...fresh, promptOwner: "owner-1" }, { type: "example_chosen" })).toEqual({
      ...fresh,
      promptOwner: "owner-1",
      exampleUsed: true,
    });
  });

  it("records a kept copy and its owner; keeping an existing copy again only changes the owner", () => {
    expect(run(fresh, { type: "draft_kept", draftId: "draft-2", ownerId: null })).toEqual({
      ...fresh,
      textDraftId: "draft-2",
    });
    expect(run(full, { type: "prompt_claimed", ownerId: "owner-2" })).toEqual({ ...full, promptOwner: "owner-2" });
  });

  // The two "Start a new prompt" buttons reset different sets of values today. That is preserved on
  // purpose (docs/state-machines.md, rule 5) and is a candidate fix for a later change.
  it("the restored-prompt button forgets the prompt and keeps the lock", () => {
    expect(run(full, { type: "new_prompt_started" })).toEqual({
      ...full,
      textDraftId: null,
      promptOwner: null,
      exampleUsed: false,
      resumedPrompt: false,
      recoveryLocked: true,
    });
  });

  it("the other-account button forgets the prompt and the lock", () => {
    expect(run(full, { type: "other_account_prompt_set_aside" })).toEqual({
      ...full,
      textDraftId: null,
      promptOwner: null,
      exampleUsed: false,
      resumedPrompt: false,
      recoveryLocked: false,
    });
  });

  it("neither button touches a send, an opening project or the loaded mark", () => {
    for (const type of ["new_prompt_started", "other_account_prompt_set_aside"] as const)
      expect(run(full, { type })).toMatchObject({ recoveryLoaded: true, submitting: true, opening: full.opening });
  });

  it("follows a send from start to finish", () => {
    const sending = run(fresh, { type: "send_started" });
    expect(sending.submitting).toBe(true);
    expect(run(sending, { type: "send_finished" })).toEqual(fresh);
  });

  it("holds the project being opened, and drops it when the router refuses", () => {
    const opening = run(fresh, { type: "project_opening", fence: "owner-1:1", href: "/projects/p1" });
    expect(opening).toEqual({ ...fresh, opening: { fence: "owner-1:1", href: "/projects/p1" } });
    expect(run(opening, { type: "project_open_failed" })).toEqual(fresh);
  });

  it("returns the same state when an event changes nothing", () => {
    for (const event of [
      { type: "send_finished" },
      { type: "project_open_failed" },
      { type: "new_prompt_started" },
      { type: "prompt_edited", ownerId: null },
    ] satisfies HomeStartFormEvent[])
      expect(homeStartFormReducer(fresh, event)).toBe(fresh);
    expect(homeStartFormReducer(full, { type: "send_started" })).toBe(full);
  });
});
