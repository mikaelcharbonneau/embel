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

/** Publishes what the step's folded entry says once the step is finished. Pass null when nothing is chosen. */
export function useWorkspaceStepSummary(step: WorkspaceSummaryStep, summary: WorkspaceStepSummary | null) {
  const setSummary = useContext(WorkspaceSlotContext)?.setSummary;
  const key = summary ? JSON.stringify(summary) : null;
  useEffect(() => {
    setSummary?.(step, key ? (JSON.parse(key) as WorkspaceStepSummary) : null);
  }, [setSummary, step, key]);
}
