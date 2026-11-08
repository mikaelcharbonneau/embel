"use client";

import { createContext, useContext } from "react";
import type { ProjectScope } from "@/domain/projects";

/** The open project's scope and next step, provided by the project workspace so
 * its pages can tell where the project stands without reading it again. */
export type ProjectProgress = { projectId: string; scope: ProjectScope; nextHref: string | null };
export const ProjectProgressContext = createContext<ProjectProgress | null>(null);
export function useProjectProgress() { return useContext(ProjectProgressContext); }
