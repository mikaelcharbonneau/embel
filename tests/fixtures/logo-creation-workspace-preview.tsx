/** TEST ONLY: the actual production workspace/hooks against Playwright-intercepted
 * synthetic same-origin HTTP. Never import from an application route. */
import { createRoot } from "react-dom/client";
import { AccountSessionProvider, useAccountSession } from "../../src/components/workspace/account-session";
import { LogoCreationWorkspace } from "../../src/components/logo-creation/logo-creation-workspace";
import "../../src/styles/globals.css";
import "../../src/styles/project-workspace.css";
import "./logo-creation-workspace-preview.css";
function Preview() {
  const session = useAccountSession();
  // Every Logo page belongs to a saved project; any other path shows "Project unavailable".
  const projectId = location.pathname.match(/\/account\/([^/]+)\/logo/)?.[1] ?? "";
  return <main style={{ maxWidth: 1140, margin: "auto", padding: 20 }}>
    <p>Local synthetic test only. No live provider, storage or charges.</p>
    <button type="button" onClick={session.refresh}>Recheck test account</button>
    <LogoCreationWorkspace projectId={projectId} mode={location.pathname.endsWith("/editor") ? "refine" : "setup"} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<AccountSessionProvider><Preview /></AccountSessionProvider>);
