"use client";
import { useLayoutEffect, useRef } from "react";
import type { ProjectIdentityController } from "./use-project-identity";

/** Native modal content must carry its own feedback: the workspace behind it is inert. */
export function IdentityEditorFeedback({ controller }: { controller: Pick<ProjectIdentityController, "error" | "notice" | "loading" | "pending" | "refresh"> }) {
  const feedback = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dialog = feedback.current?.closest("dialog");
    // Only a new response in the active editor scrolls. Background polling,
    // unchanged messages and hidden editors must not move the viewport or focus.
    if ((controller.error || controller.notice) && dialog?.open) dialog.scrollTo?.({ top: 0, behavior: "instant" });
  }, [controller.error, controller.notice]);
  if (!controller.error && !controller.notice) return null;
  return <div ref={feedback}>
    {controller.error && <div className="identity-notice identity-error"><p role="alert">{controller.error}</p><button type="button" className="text-link" disabled={controller.loading || controller.pending} onClick={() => void controller.refresh()}>Check latest saved inputs</button></div>}
    {controller.notice && <p className="identity-notice" role="status">{controller.notice}</p>}
  </div>;
}
