"use client";

import { createContext, useContext, useEffect } from "react";
import type { JourneyStepId, JourneyStepView } from "@/domain/journey";
import type { SaveState } from "./project-capsule";

/** What a project page shows in the shell's floating bar. */
export type ProjectHeader = {
  projectId: string;
  projectName: string;
  steps: JourneyStepView[];
  saveState: SaveState | null;
  /** The project couldn't be opened: the bar returns to the app's navigation instead of waiting for a name. */
  unavailable?: boolean;
};

export const ProjectHeaderContext = createContext<(header: ProjectHeader | null) => void>(() => undefined);

/** A project page publishes its header to the app shell, which owns the bar.
 * Equal content is not republished, and leaving the page clears it. */
export function useProjectHeader(header: ProjectHeader | null) {
  const publish = useContext(ProjectHeaderContext);
  const key = header ? JSON.stringify(header) : null;
  useEffect(() => {
    publish(key ? (JSON.parse(key) as ProjectHeader) : null);
  }, [publish, key]);
  useEffect(() => () => publish(null), [publish]);
}

/** The project conversation holds the Strategy and Voice steps as sections.
 * `reached` is the furthest step it has reached, `viewed` the one on screen,
 * and `sections` the steps it currently shows. */
export type ConversationSteps = { reached: JourneyStepId; viewed: JourneyStepId; sections: readonly JourneyStepId[] };

/** The element id of a step's section in the project conversation. */
export function journeySectionId(step: JourneyStepId) {
  return `journey-${step}`;
}
/** The step a `#journey-…` link points at, if any. */
export function journeySectionOfHash(hash: string): JourneyStepId | null {
  const match = /^#journey-(strategy|voice|identity)$/u.exec(hash);
  return match ? (match[1] as JourneyStepId) : null;
}
/** Asks the conversation to show a step's section. The conversation owns its
 * scrolling, so the project bar only signals the section it wants. */
export const JOURNEY_SECTION_EVENT = "embel:journey-section";

export const ConversationStepContext = createContext<(steps: ConversationSteps | null) => void>(() => undefined);
/** The project conversation reports its steps so the project bar highlights the
 * one being viewed and links the others to their sections. */
export function useConversationSteps(
  reached: JourneyStepId | null,
  viewed: JourneyStepId | null,
  sections: readonly JourneyStepId[],
) {
  const report = useContext(ConversationStepContext);
  const list = sections.join(" ");
  useEffect(() => {
    const shown = list ? (list.split(" ") as JourneyStepId[]) : [];
    report(reached ? { reached, viewed: viewed && shown.includes(viewed) ? viewed : reached, sections: shown } : null);
    return () => report(null);
  }, [report, reached, viewed, list]);
}
