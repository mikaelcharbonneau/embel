"use client";

import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";

const FOLLOW_DISTANCE = 96;

/** Follow new conversation content only while the reader remains near its end. */
export function useConversationFollow({ conversationKey, contentKey, responseIds }: {
  conversationKey: string;
  contentKey: string;
  responseIds: readonly string[];
}) {
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const previous = useRef<{ conversationKey: string; responseIds: readonly string[] } | null>(null);
  const unread = useRef<string[]>([]);
  const [hasNewResponse, setHasNewResponse] = useState(false);
  const responseKey = JSON.stringify(responseIds);

  function nearBottom(area: HTMLDivElement) {
    return area.scrollHeight - area.clientHeight - Math.max(0, area.scrollTop) <= FOLLOW_DISTANCE;
  }

  function responseElement(area: HTMLDivElement, id: string | undefined) {
    const element = id ? document.getElementById(id) : null;
    return element && area.contains(element) ? element : null;
  }

  function scrollToResponse(area: HTMLDivElement, target: HTMLElement | null, behavior: ScrollBehavior) {
    const top = target ? area.scrollTop + target.getBoundingClientRect().top - area.getBoundingClientRect().top - 24 : area.scrollHeight;
    area.scrollTo?.({ top: Math.max(0, top), behavior });
  }

  const updateContent = useEffectEvent(() => {
    const area = transcript.current;
    if (!area) return;
    const prior = previous.current;
    const initial = !prior || prior.conversationKey !== conversationKey;
    const added = initial ? [] : responseIds.filter(id => !prior.responseIds.includes(id));
    previous.current = { conversationKey, responseIds };

    if (initial || following.current) {
      unread.current = [];
      setHasNewResponse(false);
      // Reveal the start of a long answer rather than skipping to its last card.
      const target = responseElement(area, initial ? responseIds.at(-1) : added[0]);
      scrollToResponse(area, target, "auto");
      following.current = nearBottom(area);
    } else if (added.length) {
      unread.current = [...unread.current, ...added];
      setHasNewResponse(true);
    }
  });

  useLayoutEffect(() => { updateContent(); }, [conversationKey, contentKey, responseKey]);

  function onScroll() {
    const area = transcript.current;
    if (!area) return;
    following.current = nearBottom(area);
    if (following.current) {
      unread.current = [];
      setHasNewResponse(false);
    }
  }

  /** Shows an earlier part of the conversation, such as a journey step. Following
   * resumes only once the reader returns to the end. */
  function jumpTo(target: HTMLElement) {
    const area = transcript.current;
    if (!area || !area.contains(target)) return;
    scrollToResponse(area, target, "auto");
    following.current = nearBottom(area);
    if (following.current) { unread.current = []; setHasNewResponse(false); }
  }

  function revealNewResponse() {
    const area = transcript.current;
    if (!area) return;
    const target = unread.current.map(id => responseElement(area, id)).find(Boolean) ?? responseElement(area, responseIds.at(-1));
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    // Only this explicit action moves keyboard focus. Background replies never do.
    (target ?? area).focus({ preventScroll: true });
    scrollToResponse(area, target, reducedMotion ? "auto" : "smooth");
    unread.current = [];
    setHasNewResponse(false);
  }

  return { transcript, onScroll, hasNewResponse, revealNewResponse, jumpTo };
}
