import type { SaveState } from "@/components/journey/project-capsule";
import { accountDraftChanged, type AccountSaveActivity, type AccountWorkspace } from "./account-draft-memory";

/** Every save situation a saved project can be in. The project bar and the project page both read
 * `accountSaveStatus`; neither works it out again (docs/state-machines.md, J3). */
export type AccountSaveStatus =
  /** The project has not been read, or its latest save could not be checked. */
  | "unknown"
  /** A save request is in flight. */
  | "saving"
  /** The latest saved version is being loaded to replace this tab's edits. */
  | "loading_latest"
  /** A newer version is saved in the account; this tab's edits are kept and not saved. */
  | "conflict"
  /** A save was tried and did not go through; the page offers Retry. */
  | "failed"
  /** An edit the open page will save on its own in a moment. */
  | "queued"
  /** Edits kept in this tab that no open page is saving. */
  | "unsaved"
  /** This tab matches a version the server confirmed. */
  | "saved";

/** The order of the checks is the priority. "saved" is only reachable when this tab's draft equals a
 * server-confirmed version with nothing pending, and that version's last read did not fail. */
export function accountSaveStatus({
  workspace,
  activity,
  readFailed = false,
}: {
  workspace: AccountWorkspace | null;
  activity: AccountSaveActivity | null;
  /** The project bar could not check the latest saved version. */
  readFailed?: boolean;
}): AccountSaveStatus {
  if (!workspace) return "unknown";
  if (activity?.busy === "save") return "saving";
  if (activity?.busy === "load") return "loading_latest";
  if (workspace.conflict) return "conflict";
  if (accountDraftChanged(workspace)) {
    // A save that was sent stays "failed" until it is confirmed or retried, also after its page closes.
    if (activity?.failed || workspace.pendingDraftSave || workspace.pendingGuidedContext) return "failed";
    return activity?.autosave ? "queued" : "unsaved";
  }
  return readFailed ? "unknown" : "saved";
}

/** The words the project page shows. */
export function accountSaveLabel(status: AccountSaveStatus) {
  if (status === "saved") return "Saved";
  if (status === "saving" || status === "queued") return "Saving…";
  if (status === "loading_latest") return "Loading the latest version…";
  return "Changes not saved";
}

/** The project bar's indicator: nothing while unknown, and never "Saving…" unless a save is under way. */
export function accountBarSaveState(status: AccountSaveStatus): SaveState | null {
  if (status === "unknown") return null;
  if (status === "saved") return "saved";
  if (status === "saving" || status === "queued") return "saving";
  if (status === "unsaved") return "unsaved";
  return "error";
}
