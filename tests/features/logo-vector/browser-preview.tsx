/** TEST ONLY. The actual production account editor against intercepted HTTP. */
import { createRoot } from "react-dom/client";
import { AccountSessionProvider, useAccountSession } from "../../../src/components/workspace/account-session";
import { LogoEditorWorkspace } from "../../../src/features/logo-vector/components/logo-editor-workspace";
function Preview() {
  const session = useAccountSession(), projectId = location.pathname.match(/\/account\/([^/]+)/)?.[1] ?? "invalid";
  return <main style={{ maxWidth: 1140, margin: "auto", padding: 12 }}><p>Synthetic local vector fixture. No live provider, storage or spending.</p><button onClick={session.refresh}>Recheck test account</button><LogoEditorWorkspace projectId={projectId} /></main>;
}
createRoot(document.getElementById("root")!).render(<AccountSessionProvider><Preview /></AccountSessionProvider>);
