"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccountSession } from "@/components/workspace/account-session";
import { type StandaloneCapabilities } from "@/domain/standalone-live-checks";
import { type StandaloneDraftMemory } from "./standalone-draft-memory";
import { loadStandaloneCapabilities, createStandaloneLiveAdapters, type LiveLookupBinding } from "./standalone-live-client";

export function useStandaloneLiveChecks(memory: StandaloneDraftMemory) {
  const { session, isCurrent } = useAccountSession();
  const key = session.status === "ready" ? `${session.userId}:${session.generation}` : null;
  const [loaded, setLoaded] = useState<{ key: string; capabilities: StandaloneCapabilities; binding: LiveLookupBinding } | null>(null);
  useEffect(() => {
    if (session.status !== "ready" || !key) return;
    const controller = new AbortController();
    const binding = { ownerId: session.userId, isCurrent: () => isCurrent(session) && memory.isCurrent(session), signal: controller.signal };
    void loadStandaloneCapabilities(binding).then(capabilities => { if (!controller.signal.aborted && binding.isCurrent()) setLoaded({ key, capabilities, binding }); }).catch(() => {});
    return () => controller.abort();
  }, [session, key, isCurrent, memory]);
  return useMemo(() => loaded && loaded.key === key && !loaded.binding.signal.aborted ? createStandaloneLiveAdapters(loaded.capabilities, loaded.binding) : null, [loaded, key]);
}
