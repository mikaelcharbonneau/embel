"use client";
import type { ProjectIdentityController } from "./use-project-identity";

/** Native modal content must carry its own feedback: the workspace behind it is inert. */
export function IdentityEditorFeedback({ controller }: { controller: Pick<ProjectIdentityController, "error" | "notice" | "loading" | "pending" | "refresh"> }) {
  return <>
    {controller.error && <div className="identity-notice identity-error"><p role="alert">{controller.error}</p><button type="button" className="text-link" disabled={controller.loading || controller.pending} onClick={() => void controller.refresh()}>Check latest saved inputs</button></div>}
    {controller.notice && <p className="identity-notice" role="status">{controller.notice}</p>}
  </>;
}
