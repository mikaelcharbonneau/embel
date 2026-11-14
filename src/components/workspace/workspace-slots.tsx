"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * The Workspace's slots for steps rendered in its work area (names, logo concepts, creative directions). A step
 * component renders its work as children of the work area and uses these hooks for the rest:
 *
 * - `useWorkspaceReply` (workspace-reply.tsx): its chips, Send and Stop in the reply box.
 * - `useWorkspaceChatSlot`: a place in the chat, under Embel's message for the step, for its own status (a progress
 *   bar, an error with its one button). Render into it with `createPortal`.
 * - `useWorkspaceResultRows`: results that must all be in view (2: six logo concepts, 1: three direction boards).
 * - `useWorkspaceStepSummary`: the one-line answer its folded entry shows in the chat once the step is finished.
 * - `useWorkspaceStepMessage`: the words of Embel's message for the step, which change with the step's state.
 */
export type WorkspaceStepSummary = {
  /** "Concept 1, version 2", "Editorial Soft Shapes". */
  answer: string;
  /** A small picture of the chosen result (44 px in the folded entry). */
  thumbnail?: { src: string; alt: string };
};
export type WorkspaceSummaryStep = "logo" | "directions";
type Slots = {
  chat: HTMLElement | null;
  /** Where a dialog about the work renders its non-modal `e-workspace__overlay` (name details). */
  overlay: HTMLElement | null;
  setRows: (owner: symbol, rows: 1 | 2 | null) => void;
  setSummary: (step: WorkspaceSummaryStep, summary: WorkspaceStepSummary | null) => void;
  /** Optional: a Workspace without per-step messages ignores them. */
  setMessage?: (step: WorkspaceSummaryStep, text: string | null) => void;
};
export const WorkspaceSlotContext = createContext<Slots | null>(null);

/** The chat's slot for the step on screen, or null outside the Workspace (render nothing there). */
export function useWorkspaceChatSlot(): HTMLElement | null {
  return useContext(WorkspaceSlotContext)?.chat ?? null;
}

/** The element a dialog about the work renders its `e-workspace__overlay` into (with `createPortal`), so it covers
 * the work area only and the chat stays usable. Null outside the Workspace. */
export function useWorkspaceOverlayHost(): HTMLElement | null {
  return useContext(WorkspaceSlotContext)?.overlay ?? null;
}

/** Asks the work area to keep this many rows of results in view while the component is mounted. */
export function useWorkspaceResultRows(rows: 1 | 2 | null) {
  const setRows = useContext(WorkspaceSlotContext)?.setRows;
  const [owner] = useState(() => Symbol("rows"));
  useEffect(() => {
    setRows?.(owner, rows);
    return () => setRows?.(owner, null);
  }, [setRows, owner, rows]);
}

/** Publishes what the step's folded entry says once the step is finished. Null means nothing to say yet (the choice
 * is still being read): the entry keeps what it last showed. */
export function useWorkspaceStepSummary(step: WorkspaceSummaryStep, summary: WorkspaceStepSummary | null) {
  const setSummary = useContext(WorkspaceSlotContext)?.setSummary;
  const key = summary ? JSON.stringify(summary) : null;
  useEffect(() => {
    if (key) setSummary?.(step, JSON.parse(key) as WorkspaceStepSummary);
  }, [setSummary, step, key]);
}

/**
 * What Embel says about the step on screen, as its state changes ("I'm drawing six concepts…", "Concept 1 is your
 * logo…"). An empty text leaves only the message's label (an error in the chat slot says it all); null hands the
 * message back to the conversation's own words. Cleared when the step leaves the work area.
 */
export function useWorkspaceStepMessage(step: WorkspaceSummaryStep, text: string | null) {
  const setMessage = useContext(WorkspaceSlotContext)?.setMessage;
  useEffect(() => {
    setMessage?.(step, text);
  }, [setMessage, step, text]);
  useEffect(() => () => setMessage?.(step, null), [setMessage, step]);
}

/** The thumbnail's longest side in device pixels: twice the folded entry's 44 px. */
const THUMBNAIL_PIXELS = 88;

/**
 * A small copy of a private preview (a blob URL that is released when its step leaves the work area) as a data URL,
 * so the folded entry keeps its picture after the step is gone. `settled` is false while it is being drawn; `data` is
 * null when it cannot be drawn.
 */
export function useThumbnail(url: string | null): { settled: boolean; data: string | null } {
  const [thumbnail, setThumbnail] = useState<{ url: string; data: string | null } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const image = new Image();
    const settle = (data: string | null) => {
      if (!cancelled) setThumbnail({ url, data });
    };
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) return settle(null);
      const scale = Math.min(1, THUMBNAIL_PIXELS / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      try {
        const context = canvas.getContext("2d");
        if (!context) return settle(null);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        settle(canvas.toDataURL("image/png"));
      } catch {
        settle(null);
      }
    };
    image.onerror = () => settle(null);
    image.src = url;
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [url]);
  const own = thumbnail && thumbnail.url === url ? thumbnail : null;
  return { settled: Boolean(own), data: own?.data ?? null };
}

/**
 * Publishes a finished step's folded answer with a small copy of its picture. While the picture is still loading or
 * being drawn nothing new is published, so the entry keeps its last answer and picture; pass `picture: null` when
 * there is none to wait for.
 */
export function useWorkspaceStepAnswer(
  step: WorkspaceSummaryStep,
  answer: string | null,
  picture: { url: string | null; alt: string } | null,
) {
  const thumbnail = useThumbnail(answer ? (picture?.url ?? null) : null);
  const waiting = Boolean(picture && (!picture.url || !thumbnail.settled));
  useWorkspaceStepSummary(
    step,
    answer && !waiting
      ? { answer, thumbnail: thumbnail.data && picture ? { src: thumbnail.data, alt: picture.alt } : undefined }
      : null,
  );
}
