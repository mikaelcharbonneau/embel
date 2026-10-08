"use client";

import { useEffect, useState } from "react";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "../../../components/identity/account-logo-client";
import type { VerifiedAccount } from "../../../components/workspace/account-session";
import type { LogoVectorRevision } from "../../../domain/logo-vector";
import { loadLogoTextContext, type LogoTextEditContext } from "../client/text-context";
import { TextControls } from "./text-controls";

type Props = Omit<Parameters<typeof TextControls>[0], "fonts" | "briefName" | "logoType"> & {
  account: VerifiedAccount;
  client: AccountLogoClient;
  revision: LogoVectorRevision;
  isCurrent(): boolean;
};
export function OwnedTextControls({ account, client, revision, isCurrent, ...controls }: Props) {
  const [attempt, setAttempt] = useState(0), [read, setRead] = useState<{ client: AccountLogoClient; source: string; context: LogoTextEditContext | null; failed: boolean } | null>(null);
  const source = `${revision.id}:${attempt}`, current = isCurrent() && isAccountLogoClientCurrent(client, account, revision.projectId) && revision.ownerId === account.userId;
  useEffect(() => {
    if (!current) return;
    const controller = new AbortController();
    void loadLogoTextContext({ account, client, revision, isCurrent }, controller.signal).then(context => {
      if (context && !controller.signal.aborted && isCurrent() && isAccountLogoClientCurrent(client, account, revision.projectId)) setRead({ client, source, context, failed: false });
    }).catch(() => { if (!controller.signal.aborted && isCurrent() && isAccountLogoClientCurrent(client, account, revision.projectId)) setRead({ client, source, context: null, failed: true }); });
    return () => controller.abort();
  }, [account, client, current, isCurrent, revision, source]);
  if (!current) return null;
  const visible = read?.client === client && read.source === source ? read : null;
  if (!visible) return <p role="status">Loading verified text controls…</p>;
  if (!visible.context) return <section aria-label="Text controls"><p role="status">The saved lettering source or owned font list could not be verified.</p><button type="button" disabled={Boolean(controls.disabledReason)} onClick={() => setAttempt(value => value + 1)}>Reload text controls</button></section>;
  return <TextControls {...controls} {...visible.context} />;
}
