"use client";

import { useEffect, useState } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { createStandaloneLiveAdapters, loadStandaloneCapabilities } from "@/components/tools/standalone-live-client";
import type { DomainCheck, DomainQuote } from "@/features/domain-workspace/model";

export type LiveChecks = ReturnType<typeof createStandaloneLiveAdapters>;

/**
 * Which live checks are connected for this account. Opening a name's details reads only this list (one GET);
 * nothing is looked up until the person asks for it.
 */
export function useLiveChecks(account: VerifiedAccount) {
  const { isCurrent } = useAccountSession();
  const [adapters, setAdapters] = useState<LiveChecks | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { userId, generation } = account;
  useEffect(() => {
    const controller = new AbortController();
    const captured = { status: "ready" as const, userId, generation };
    const binding = { ownerId: userId, signal: controller.signal, isCurrent: () => isCurrent(captured) };
    void loadStandaloneCapabilities(binding)
      .then((caps) => {
        if (!controller.signal.aborted && binding.isCurrent()) setAdapters(createStandaloneLiveAdapters(caps, binding));
      })
      .catch(() => {
        if (!controller.signal.aborted && binding.isCurrent()) setConnectionError(true);
      });
    return () => controller.abort();
  }, [userId, generation, isCurrent, attempt]);
  return {
    adapters,
    connectionError,
    retry: () => {
      setConnectionError(false);
      setAttempt((value) => value + 1);
    },
  };
}

// Domain checks the person ran are kept while the page is open, so reopening a name shows its last result and when
// it was checked. Only the signed-in account's own checks are kept.
let rememberedOwner: string | null = null;
const rememberedDomains = new Map<string, { check: DomainCheck; quote: DomainQuote | null }>();
export function rememberedDomainChecks(account: VerifiedAccount) {
  if (rememberedOwner !== account.userId) {
    rememberedDomains.clear();
    rememberedOwner = account.userId;
  }
  return rememberedDomains;
}

/** Provider names for the line under a result. */
export const providerLabels: Record<string, string> = {
  namecom_core: "Name.com",
  cloudflare_registrar: "Cloudflare",
  vercel_registrar: "Vercel",
  "Public registry RDAP": "the public registry",
  "Public DNS": "public DNS",
};

export function checkedTime(at: string) {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
