"use client";

import { useState } from "react";
import { z } from "zod";

// Earlier visits also stored a position and a minimized state; those controls
// are gone and the extra fields are ignored.
const layoutSchema = z.object({ expanded: z.boolean() });
export type NamingComposerLayout = z.infer<typeof layoutSchema>;
const initial: NamingComposerLayout = { expanded: false };

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
    try { window.localStorage.setItem(key, JSON.stringify({ ...(readLayout(key) ?? layout), ...patch })); }
    catch { /* The control still works for the current visit. */ }
  }
  return { layout, changeLayout };
}
