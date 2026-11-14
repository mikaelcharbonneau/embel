"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Spinner } from "@/components/ui/button";
import { GuidedChoicesLoading } from "./guided-interview-widgets";
import { Workspace } from "./workspace-layout";
import { WorkspaceReplyBox } from "./workspace-reply";

/** Embel is composing a reply: a spinner beside one plain sentence. Stopping is in the reply box. */
export function GuidedThinking({ label = "Thinking…", action }: { label?: string; action?: ReactNode }) {
  return (
    <div className="e-thinking" role="status" aria-label={label === "Thinking…" ? "Embel is thinking" : label}>
      <Spinner />
      <span>{label}</span>
      {action}
    </div>
  );
}

/** Keeps the submitted prompt visible while its account project is being saved, in the shape of the conversation
 * it opens into: the brief in the chat, the competitors' places in the work area. */
export function OpeningGuidedConversation({
  prompt,
  status = "Saving your project…",
  href,
}: {
  prompt: string;
  status?: string;
  href?: string | null;
}) {
  return (
    <div className="guided-interview guided-interview-opening">
      <Workspace
        log={
          <>
            <div className="e-turn e-turn--user e-turn--settled">
              <div className="e-turn__bubble">
                <p className="e-turn__text">{prompt}</p>
              </div>
            </div>
            <article className="e-turn e-turn--settled" aria-label="Embel status">
              <div className="e-turn__main">
                <p className="e-turn__meta">Embel</p>
                <GuidedThinking
                  label={status}
                  action={
                    href && (
                      <Link className="e-link" href={href}>
                        Open saved project
                      </Link>
                    )
                  }
                />
              </div>
            </article>
          </>
        }
        reply={<WorkspaceReplyBox value="" onChange={() => undefined} action={null} readOnly textDisabled />}
        work={<GuidedChoicesLoading stage="competitors" title="Competitors" />}
      />
    </div>
  );
}
