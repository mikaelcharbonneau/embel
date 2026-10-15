"use client";

import { ProjectArtwork } from "@/components/ui/project-artwork";
import { ConversationComposer } from "./conversation-composer";

export function GuidedThinking({ onStop, stopping = false, stopDisabled = false }: { onStop?: () => void; stopping?: boolean; stopDisabled?: boolean }) {
  return <div className="guided-thinking" role="status" aria-label="Embel is thinking">
    <ProjectArtwork name="mark" /><span>{stopping ? "Stopping…" : "Thinking…"}</span>
    {onStop && <button type="button" className="text-link" disabled={stopping || stopDisabled} onClick={onStop}>Stop</button>}
  </div>;
}

/** Keeps the submitted prompt visible while its account project is being saved. */
export function OpeningGuidedConversation({ prompt }: { prompt: string }) {
  return <div className="guided-interview guided-interview-opening" aria-label="Brand conversation">
    <div className="guided-interview-scroll" role="log" aria-label="Conversation" aria-live="polite">
      <div className="guided-user-message"><span className="sr-only">You</span><p>{prompt}</p></div>
      <GuidedThinking />
    </div>
    <div className="guided-interview-compose"><ConversationComposer project value="" onChange={() => {}} onSend={() => {}} label="Message Embel" placeholder="Reply in your own words, or ask a question…" disabled readOnly hint={null} /></div>
  </div>;
}
