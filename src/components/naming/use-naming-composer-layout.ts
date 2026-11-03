"use client";

import { useState } from "react";
import { z } from "zod";

const fraction = z.number().min(0).max(1);
const layoutSchema = z.object({
  position: z.object({ x: fraction, y: fraction }).nullable(),
  minimized: z.boolean(),
  expanded: z.boolean(),
});
export type NamingComposerLayout = z.infer<typeof layoutSchema>;
const initial: NamingComposerLayout = { position: null, minimized: false, expanded: false };

function readLayout(key: string) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? layoutSchema.safeParse(JSON.parse(raw)).data : undefined;
  } catch { return undefined; }
}

// The verified Naming workspace remounts for each account and project.
export function useNamingComposerLayout(ownerId: string, projectId: string) {
  const key = `embel.naming-composer.v1:${ownerId}:${projectId}`;
  const [layout, setLayout] = useState(() => readLayout(key) ?? initial);
  function changeLayout(patch: Partial<NamingComposerLayout>) {
    setLayout(previous => ({ ...previous, ...patch }));
    try {
      // A tab changing only the mode shouldn't overwrite another tab's position.
      const next = { ...(readLayout(key) ?? layout), ...patch };
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch { /* The controls still work for the current visit. */ }
  }
  return { layout, changeLayout };
}
