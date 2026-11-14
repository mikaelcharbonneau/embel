import { createRoot } from "react-dom/client";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { AccountProfileProvider, useAccountProfile } from "@/components/workspace/account-profile-provider";
import { AccountAccessNotice } from "@/components/workspace/account-access";
import { SettingsWorkspace } from "@/components/workspace/settings-workspace";
import { BrowserLocalDate } from "@/components/workspace/browser-local-date";
import "@/styles/tokens.css";
import "@/styles/globals.css";
import "@/styles/settings-guided.css";
import "./account-profile-preview.css";

function Preview() {
  const { refresh } = useAccountSession(),
    profile = useAccountProfile();
  return (
    <>
      <aside style={{ padding: 16, background: "#fff0fd" }}>
        Synthetic profile browser fixture · no live account backend
      </aside>
      <header style={{ padding: 16, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <span data-profile-name>{profile?.workspace?.saved.values.fullName || "My account"}</span>
        <button type="button" onClick={refresh}>
          Recheck fixture account
        </button>
      </header>
      <AccountAccessNotice />
      <SettingsWorkspace />
      <section style={{ padding: 24 }} aria-label="Activity date fixture">
        <BrowserLocalDate dateTime="2026-10-13T00:30:00Z" />
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <AccountSessionProvider>
    <AccountProfileProvider>
      <Preview />
    </AccountProfileProvider>
  </AccountSessionProvider>,
);
