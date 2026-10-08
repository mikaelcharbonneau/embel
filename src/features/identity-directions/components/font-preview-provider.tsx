"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import { useAccountSession } from "@/components/workspace/account-session";
import type { FontPreviewReader } from "../model/font-preview";
import { createFontPreviewHttpReader } from "./font-preview-http";

const PreviewContext = createContext<FontPreviewReader | undefined>(undefined);
export const useFontPreviewReader = () => useContext(PreviewContext);

/** Shared only within one account/project view. Session-generation changes
 * replace the reader and hide old specimens before any late result is accepted. */
export function FontPreviewProvider({ client, projectId, children }: { client: AccountLogoClient; projectId: string; children: ReactNode }): React.JSX.Element {
  const { session, isCurrent, expire } = useAccountSession();
  const reader = useMemo(() => session.status === "ready" && isCurrent(session)
    ? createFontPreviewHttpReader({ client, projectId, account: session, isCurrent, expire }) : undefined, [client, projectId, session, isCurrent, expire]);
  return <PreviewContext.Provider value={reader}>{children}</PreviewContext.Provider>;
}
