"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ProjectArtwork } from "@/components/ui/project-artwork";
import { ConversationComposer } from "./conversation-composer";

export function GuidedThinking({ onStop, stopping = false, stopDisabled = false, label = "Thinking…" }: { onStop?: () => void; stopping?: boolean; stopDisabled?: boolean; label?: string }) {
  return <div className="guided-thinking flow-enter" role="status" aria-label={stopping ? "Stopping…" : label === "Thinking…" ? "Embel is thinking" : label}>
    <ProjectArtwork name="mark" /><span>{stopping ? "Stopping…" : label}</span>
    {onStop && <button type="button" className="text-link" disabled={stopping || stopDisabled} onClick={onStop}>Stop</button>}
  </div>;
}

/** Keeps the submitted prompt visible while its account project is being saved. */
export function OpeningGuidedConversation({ prompt, status = "Saving your project…", href }: { prompt: string; status?: string; href?: string | null }) {
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: "instant" }); }, [prompt]);
  return <div className="guided-interview guided-interview-opening" aria-label="Brand conversation">
    <div ref={transcript} className="guided-interview-scroll" role="log" aria-label="Conversation" aria-live="polite">
      <div className="guided-user-message flow-enter"><span className="sr-only">You</span><p>{prompt}</p></div>
      <GuidedThinking label={status} />
      {href && <Link className="text-link" href={href}>Open saved project</Link>}
    </div>
    <div className="guided-interview-compose"><ConversationComposer project value="" onChange={() => {}} onSend={() => {}} label="Message Embel" placeholder="Reply in your own words, or ask a question…" disabled readOnly hint={null} /></div>
  </div>;
}
