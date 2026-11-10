"use client";

import { useEffect, useState } from "react";
import type { LogoRasterSource } from "../../domain/logo-workspace";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "../identity/account-logo-client";
import { useAccountSession, type VerifiedAccount } from "../workspace/account-session";
import { readLogoCandidate, type LogoCandidateReview } from "./candidate-review";

/** Read-only exact-version inspection; late responses cannot cross an account,
 * project or source change. No history selection or mutation is performed. */
export function useLogoCandidate(
  client: AccountLogoClient | null,
  account: VerifiedAccount,
  projectId: string | undefined,
  source: LogoRasterSource | null,
) {
  const { isCurrent } = useAccountSession();
  const request = source ? JSON.stringify(source) : null;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    client: AccountLogoClient;
    request: string;
    item: LogoCandidateReview | null;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    if (
      !client ||
      !projectId ||
      !request ||
      !isCurrent(account) ||
      !isAccountLogoClientCurrent(client, account, projectId)
    )
      return;
    const controller = new AbortController();
    const current = () =>
      !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    void readLogoCandidate({
      client,
      ownerId: account.userId,
      projectId,
      source: JSON.parse(request),
      signal: controller.signal,
    })
      .then((item) => {
        if (current()) setState({ client, request, item, error: !item });
      })
      .catch(() => {
        if (current()) setState({ client, request, item: null, error: true });
      });
    return () => controller.abort();
  }, [account, client, isCurrent, projectId, request, retry]);
  const visible =
    client &&
    projectId &&
    isCurrent(account) &&
    isAccountLogoClientCurrent(client, account, projectId) &&
    state?.client === client &&
    state.request === request
      ? state
      : null;
  return {
    item: visible?.item ?? null,
    error: visible?.error ?? false,
    loading: Boolean(request && !visible),
    refresh: () => {
      setState(null);
      setRetry((value) => value + 1);
    },
  };
}
