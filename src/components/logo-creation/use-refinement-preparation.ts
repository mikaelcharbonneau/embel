"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { LogoQuoteRequest } from "@/domain/logo-jobs";
import type { LogoRasterSource } from "@/domain/logo-workspace";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { LogoDraftMemory } from "@/components/identity/logo-draft-memory";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoCreationController } from "./creation-controller";
import { logoCandidateKey } from "./candidate-review";
import { logoDraftHasProtectedWork } from "./saved-inputs-controller";

type Request = Extract<LogoQuoteRequest, { operation: "refine_preview" }>;
type Preparation = { account: VerifiedAccount; projectId: string; client: AccountLogoClient; controller: LogoCreationController; request: Request };

/** Refresh completion and React's committed editability are separate events. */
export function useRefinementPreparation({ account, projectId, client, controller, memory, canEdit, pending, selectedSource, isCurrent, onRejected }: {
  account: VerifiedAccount; projectId?: string; client: AccountLogoClient | null; controller: LogoCreationController | null;
  memory: LogoDraftMemory; canEdit: boolean; pending: boolean; selectedSource: LogoRasterSource | null;
  isCurrent(account: VerifiedAccount): boolean; onRejected(): void;
}) {
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const occupied = useRef<Preparation | null>(null), consumed = useRef<Preparation | null>(null), mounted = useRef(false);
  const reject = useEffectEvent(onRejected);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; occupied.current = null; }; }, []);
  useEffect(() => {
    if (!preparation) return;
    const bound = () => preparation.account.userId === account.userId && preparation.account.generation === account.generation
      && preparation.projectId === projectId && preparation.client === client && preparation.controller === controller
      && isCurrent(preparation.account) && isAccountLogoClientCurrent(preparation.client, preparation.account, preparation.projectId);
    if (bound() && (!canEdit || pending)) return;
    let cancelled = false;
    queueMicrotask(async () => {
      if (cancelled || occupied.current !== preparation || consumed.current === preparation) return;
      consumed.current = preparation;
      try {
        const current = memory.get(preparation.projectId);
        if (!bound() || !current?.workspace || logoDraftHasProtectedWork(current)
          || JSON.stringify(current.workspace.heads) !== JSON.stringify(preparation.request.expected)
          || !selectedSource || logoCandidateKey(selectedSource) !== logoCandidateKey(preparation.request.source)
          || preparation.controller.getSnapshot().phase !== "idle") { reject(); return; }
        await preparation.controller.prepare(preparation.request);
      } finally {
        if (occupied.current === preparation) occupied.current = null;
        if (mounted.current) setPreparation(previous => previous === preparation ? null : previous);
      }
    });
    return () => { cancelled = true; };
  }, [account, canEdit, client, controller, isCurrent, memory, pending, preparation, projectId, selectedSource]);

  function enqueue(request: Request): boolean {
    if (occupied.current || !client || !controller || !projectId || !isCurrent(account)
      || !isAccountLogoClientCurrent(client, account, projectId)) return false;
    const next = { account, projectId, client, controller, request };
    occupied.current = next; setPreparation(next); return true;
  }
  return { enqueue, pending: preparation !== null };
}
