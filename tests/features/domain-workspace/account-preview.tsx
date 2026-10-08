import { createRoot } from "react-dom/client";
import { useLayoutEffect, useState } from "react";
import { AccountSessionProvider, useAccountSession } from "../../../src/components/workspace/account-session";
import { AccountDomainsWorkspace } from "../../../src/components/tools/domain-account-workspace";
import { createStandaloneDraftMemory } from "../../../src/components/tools/standalone-draft-memory";
import "../../../src/styles/tokens.css";
import "../../../src/styles/globals.css";
import "./preview.css";

function AccountPreview() {
  const { session, refresh, expire } = useAccountSession();
  const [memory] = useState(createStandaloneDraftMemory);
  const [visible, setVisible] = useState(true);
  // Fixture-only provider wiring. The root integration owns synchronous production
  // bind/clear and shared before-unload/sign-out guards; this tests the consumer.
  useLayoutEffect(() => { memory.bind(session.status === "ready" ? session : null); }, [memory, session]);
  return <><aside style={{ padding: 16, background: "#FFF0FD" }}>Synthetic local account fixture · no account backend or provider</aside>
    <div style={{ padding: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
      <button type="button" onClick={refresh}>Recheck fixture account</button>
      <button type="button" onClick={() => { if (session.status === "ready") expire(session); }}>Expire fixture session</button>
      <button type="button" onClick={() => setVisible(value => !value)}>{visible ? "Unmount" : "Remount"} account workspace</button>
    </div>
    {visible && <AccountDomainsWorkspace memory={memory} importProjectId="55555555-5555-4555-8555-555555555555" />}
  </>;
}
createRoot(document.getElementById("root")!).render(<AccountSessionProvider><AccountPreview /></AccountSessionProvider>);
