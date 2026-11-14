"use client";

import { useEffect, useState } from "react";
import { createAccountIdentityClient } from "@/components/identity/account-identity-client";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import type { JourneyEvidence } from "@/domain/journey";
import type { AccountProject } from "@/domain/project-api";
import { AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { readProjectJourneyEvidence } from "./project-continuation";

/** What the open project's saved logo and direction work shows, read with the same code as its project card,
 * so the journey bar and the cards give `journeyProgress` the same facts. Null while unknown. */
export function useProjectNextStep(account: VerifiedAccount, project: AccountProject | null): JourneyEvidence | null {
  const { isCurrent, expire } = useAccountSession();
  const [state, setState] = useState<{ key: string; evidence: JourneyEvidence } | null>(null);
  const { userId, generation } = account;
  const key = project ? `${userId}:${generation}:${project.id}:${project.current_revision}` : null;

  useEffect(() => {
    if (!project || !key) return;
    const captured: VerifiedAccount = { status: "ready", userId, generation };
    const controller = new AbortController();
    const clients = {
      logo: createAccountLogoClient(captured, project.id, isCurrent, expire),
      identity: createAccountIdentityClient(captured, project.id, isCurrent, expire),
    };
    const deadline = setTimeout(() => controller.abort(), 15_000);
    readProjectJourneyEvidence(project, clients, controller.signal)
      .then((evidence) => {
        if (!controller.signal.aborted && isCurrent(captured)) setState({ key, evidence });
      })
      .catch((error) => {
        if (error instanceof AccountRequestError && error.status === 401 && isCurrent(captured)) expire(captured);
      })
      .finally(() => clearTimeout(deadline));
    return () => {
      clearTimeout(deadline);
      controller.abort();
      clients.logo?.dispose();
      clients.identity?.dispose();
    };
  }, [expire, generation, isCurrent, key, project, userId]);

  return state?.key === key ? state.evidence : null;
}
