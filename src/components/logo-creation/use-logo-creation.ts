"use client";

import { useLogoDraftMemory } from "../identity/logo-draft-memory-context";
import { useLogoWorkspace } from "../identity/use-logo-workspace";

export type LogoWorkspaceController = ReturnType<typeof useLogoWorkspace>;

/** One shared owner-scoped memory. No browser persistence or feature draft copy.
 * Logo images start on the generation engine (use-logo-engine.ts). */
export function useLogoCreation(projectId: string): { workspace: LogoWorkspaceController } {
  const memory = useLogoDraftMemory();
  return { workspace: useLogoWorkspace({ projectId, memory }) };
}
