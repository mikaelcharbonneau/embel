"use client";

import { createContext, useContext, useEffect } from "react";
import type { JourneyStepId, JourneyStepView } from "@/domain/journey";
import type { SaveState } from "./project-capsule";

/** What a project page shows in the shell's floating bar. */
export type ProjectHeader = { projectId: string; projectName: string; steps: JourneyStepView[]; saveState: SaveState | null };

export const ProjectHeaderContext = createContext<(header: ProjectHeader | null) => void>(() => undefined);

/** A project page publishes its header to the app shell, which owns the bar.
 * Equal content is not republished, and leaving the page clears it. */
export function useProjectHeader(header: ProjectHeader | null) {
  const publish = useContext(ProjectHeaderContext);
  const key = header ? JSON.stringify(header) : null;
  useEffect(() => { publish(key ? JSON.parse(key) as ProjectHeader : null); }, [publish, key]);
  useEffect(() => () => publish(null), [publish]);
}

export const ConversationStepContext = createContext<(step: JourneyStepId | null) => void>(() => undefined);
/** The project conversation reports the journey step it is showing (Strategy,
 * or Voice once naming continues inline), so the project bar highlights it. */
export function useConversationStep(step: JourneyStepId | null) {
  const report = useContext(ConversationStepContext);
  useEffect(() => { report(step); return () => report(null); }, [report, step]);
}
