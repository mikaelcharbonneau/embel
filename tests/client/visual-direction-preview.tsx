import { createRoot } from "react-dom/client";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { AccountAccess, AccountAccessNotice } from "@/components/workspace/account-access";
import { VisualDirectionReview } from "@/features/identity-directions/components/visual-direction-review";
import "@/styles/tokens.css";
import "@/styles/globals.css";
import "./visual-direction-preview.css";
function Preview() {
  const { refresh } = useAccountSession();
  return <><aside style={{ padding: 16, background: "#fff0fd" }}>Explicit local browser fixture · intercepted account and saved-review API · no live provider</aside>
    <header style={{ display: "flex", gap: 16, alignItems: "center", padding: 16 }}><AccountAccess /><button type="button" onClick={refresh}>Recheck fixture account</button></header>
    <AccountAccessNotice /><main style={{ maxWidth: 1120, margin: "0 auto", padding: 16 }}><VisualDirectionReview projectId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" /></main></>;
}
createRoot(document.getElementById("root")!).render(<AccountSessionProvider><Preview /></AccountSessionProvider>);
