"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { ProjectArtwork } from "@/components/ui/project-artwork";
import { ConversationComposer } from "./conversation-composer";
import { FloatingComposer } from "./floating-composer";

export function GuidedThinking({ onStop, stopping = false, stopDisabled = false, label = "Thinking…", action }: { onStop?: () => void; stopping?: boolean; stopDisabled?: boolean; label?: string; action?: ReactNode }) {
  return <div className="guided-thinking" role="status" aria-label={stopping ? "Stopping…" : label === "Thinking…" ? "Embel is thinking" : label}>
    <ProjectArtwork name="mark" /><span>{stopping ? "Stopping…" : label}</span>
    {action}
    {onStop && <button type="button" className="text-link" disabled={stopping || stopDisabled} onClick={onStop}>Stop</button>}
  </div>;
}

/** Keeps the submitted prompt visible while its account project is being saved. */
export function OpeningGuidedConversation({ prompt, status = "Saving your project…", href }: { prompt: string; status?: string; href?: string | null }) {
  const transcript = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: "instant" }); }, [prompt]);
  return <div className="guided-interview guided-interview-opening" data-composer="floating" aria-label="Brand conversation">
    <div ref={transcript} className="guided-interview-scroll" role="log" aria-label="Conversation" aria-live="polite">
      <div className="guided-user-message guided-brief-message"><span className="sr-only">You</span><p>{prompt}</p></div>
      <GuidedThinking label={status} action={href && <Link className="text-link" href={href}>Open saved project</Link>} />
    </div>
    <FloatingComposer label="Strategy composer"><ConversationComposer project value="" onChange={() => {}} onSend={() => {}} label="Message Embel" placeholder="Reply in your own words, or ask a question…" disabled readOnly hint={null} /></FloatingComposer>
  </div>;
}
