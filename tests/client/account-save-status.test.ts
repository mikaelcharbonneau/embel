import { describe, expect, it } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import type { AccountSaveActivity, AccountWorkspace } from "@/components/workspace/account-draft-memory";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import {
  accountBarSaveState,
  accountSaveLabel,
  accountSaveStatus,
  type AccountSaveStatus,
} from "@/components/workspace/account-save-status";

const saved = accountProjectSchema.parse({
  id: "cccccccc-3333-4333-8333-333333333332",
  owner_id: "cccccccc-3333-4333-8333-333333333331",
  title: "Save status fixture",
  scope: "complete_brand",
  current_revision: 3,
  created_at: "2026-11-14T00:00:00Z",
  context: { description: "A neighborhood lunch kitchen" },
});
const clean: AccountWorkspace = {
  generation: 1,
  ownerId: saved.owner_id,
  saved,
  draft: accountProjectDraft(saved),
  conflict: false,
};
const edited: AccountWorkspace = { ...clean, draft: { ...clean.draft, description: "A lunch kitchen with a counter" } };
const sent: AccountWorkspace = {
  ...edited,
  pendingDraftSave: { body: { expectedRevision: 3, title: saved.title, context: saved.context }, draft: edited.draft },
};
// A guided answer whose save was confirmed for another branch keeps its context and a conflict.
const answer: AccountWorkspace = { ...clean, pendingGuidedContext: saved.context };
const idle: AccountSaveActivity = { autosave: true, busy: null, failed: false };
const saving: AccountSaveActivity = { ...idle, busy: "save" };
const loading: AccountSaveActivity = { ...idle, busy: "load" };
const failed: AccountSaveActivity = { ...idle, failed: true };

describe("one save status for the project bar and the project page", () => {
  it.each<[string, AccountWorkspace | null, AccountSaveActivity | null, boolean, AccountSaveStatus]>([
    ["nothing read yet", null, null, false, "unknown"],
    ["nothing read yet, page open", null, idle, false, "unknown"],
    ["matches the confirmed version", clean, idle, false, "saved"],
    ["matches the confirmed version, no page open", clean, null, false, "saved"],
    ["latest save could not be checked, nothing edited", clean, null, true, "unknown"],
    ["edited, the open page saves in a moment", edited, idle, false, "queued"],
    ["edited, no page open to save it", edited, null, false, "unsaved"],
    ["edited, latest save could not be checked", edited, null, true, "unsaved"],
    ["save in flight", sent, saving, false, "saving"],
    ["save in flight after a failed read", sent, saving, true, "saving"],
    ["save sent and not confirmed, request over", sent, idle, false, "failed"],
    ["save sent and not confirmed, page closed", sent, null, false, "failed"],
    ["save refused before it was sent", edited, failed, false, "failed"],
    ["save failed with its request kept", sent, failed, false, "failed"],
    ["guided answer not saved", answer, idle, false, "failed"],
    ["newer version saved elsewhere", { ...edited, conflict: true }, idle, false, "conflict"],
    ["newer version saved elsewhere, save also failed", { ...sent, conflict: true }, failed, false, "conflict"],
    ["newer version saved elsewhere, nothing edited", { ...clean, conflict: true }, null, false, "conflict"],
    ["loading the latest version over a conflict", { ...edited, conflict: true }, loading, false, "loading_latest"],
    ["retrying a failed save", sent, { ...failed, busy: "save" }, false, "saving"],
  ])("%s", (_name, workspace, activity, readFailed, status) => {
    expect(accountSaveStatus({ workspace, activity, readFailed })).toBe(status);
  });

  it("only says Saved for a confirmed version with nothing pending, in every combination", () => {
    const activities = [null, idle, saving, loading, failed, { ...idle, autosave: false }];
    for (const base of [clean, edited, sent, answer])
      for (const conflict of [false, true])
        for (const activity of activities)
          for (const readFailed of [false, true]) {
            const workspace = { ...base, conflict };
            const status = accountSaveStatus({ workspace, activity, readFailed });
            const confirmed = base === clean && !conflict && !activity?.busy && !readFailed;
            expect(status === "saved").toBe(confirmed);
            expect(accountSaveLabel(status) === "Saved").toBe(confirmed);
            expect(accountBarSaveState(status) === "saved").toBe(confirmed);
          }
  });

  it("turns each status into the page's words and the bar's indicator, which never disagree", () => {
    const shown = (status: AccountSaveStatus) => [accountSaveLabel(status), accountBarSaveState(status)];
    expect(shown("saved")).toEqual(["Saved", "saved"]);
    expect(shown("saving")).toEqual(["Saving…", "saving"]);
    expect(shown("queued")).toEqual(["Saving…", "saving"]);
    expect(shown("failed")).toEqual(["Changes not saved", "error"]);
    expect(shown("conflict")).toEqual(["Changes not saved", "error"]);
    expect(shown("unsaved")).toEqual(["Changes not saved", "unsaved"]);
    expect(shown("loading_latest")).toEqual(["Loading the latest version…", "error"]);
    expect(shown("unknown")).toEqual(["Changes not saved", null]);
  });
});
