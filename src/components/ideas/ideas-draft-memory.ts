import type { z } from "zod";
import type { IdeaContent, IdeaRecord, createIdeaInputSchema, updateIdeaInputSchema, createIdeaBrandInputSchema } from "@/domain/ideas";

export type IdeaWorkspace = {
  ownerId: string;
  generation: number;
  saved: IdeaRecord;
  content: IdeaContent;
  conflict: boolean;
  saveIntent: z.infer<typeof updateIdeaInputSchema> | null;
  brandIntent: z.infer<typeof createIdeaBrandInputSchema> | null;
};
export type IdeaCapture = {
  ownerId: string;
  generation: number;
  content: IdeaContent;
  intent: z.infer<typeof createIdeaInputSchema> | null;
};

export function ideaDraftChanged(workspace: IdeaWorkspace) {
  return JSON.stringify(workspace.content) !== JSON.stringify(workspace.saved.content);
}

/** Private account content lives only in the mounted session provider. */
export function createIdeaDraftMemory() {
  let owner: string | null = null;
  let capture: IdeaCapture | null = null;
  const entries = new Map<string, IdeaWorkspace>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const admits = (ownerId: string) => owner === null || owner === ownerId.toLowerCase();
  return {
    get: (ownerId: string, ideaId: string) => owner === ownerId.toLowerCase() ? entries.get(ideaId.toLowerCase()) ?? null : null,
    set: (workspace: IdeaWorkspace) => {
      if (!admits(workspace.ownerId) || workspace.saved.ownerId.toLowerCase() !== workspace.ownerId.toLowerCase()) return false;
      const key = workspace.saved.id.toLowerCase();
      if (!entries.has(key) && entries.size >= 20) {
        const clean = [...entries.entries()].find(([, entry]) => !ideaDraftChanged(entry) && !entry.saveIntent && !entry.brandIntent);
        if (!clean) return false;
        entries.delete(clean[0]);
      }
      owner = workspace.ownerId.toLowerCase();
      entries.set(key, workspace); notify(); return true;
    },
    getCapture: (ownerId: string) => owner === ownerId.toLowerCase() ? capture : null,
    setCapture: (next: IdeaCapture) => {
      if (!admits(next.ownerId)) return false;
      owner = next.ownerId.toLowerCase(); capture = next; notify(); return true;
    },
    clearCapture: (ownerId: string) => { if (owner === ownerId.toLowerCase() && capture) { capture = null; notify(); } },
    clear: () => { owner = null; capture = null; entries.clear(); notify(); },
    hasUnsaved: () => Boolean(capture && (capture.intent || capture.content.title.trim() || capture.content.description.trim())) || [...entries.values()].some(entry => ideaDraftChanged(entry) || entry.saveIntent || entry.brandIntent),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
