"use client";

import { createContext, useContext } from "react";
/** The open project's next step, provided by the project workspace so
 * its pages can tell where the project stands without reading it again. */
export type ProjectProgress = { projectId: string; nextHref: string | null };
export const ProjectProgressContext = createContext<ProjectProgress | null>(null);
export function useProjectProgress() { return useContext(ProjectProgressContext); }
