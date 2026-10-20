/** TEST ONLY: the actual production workspace/hooks against Playwright-intercepted
 * synthetic same-origin HTTP. Never import from an application route. */
import { createRoot } from "react-dom/client";
import { BrandBoardSystem } from "../../src/components/logo-creation/brand-board-system";
import { inspirationCatalog, type InspirationChoice } from "../../src/domain/inspiration";
import { AccountSessionProvider, useAccountSession } from "../../src/components/workspace/account-session";
import { LogoCreationWorkspace } from "../../src/components/logo-creation/logo-creation-workspace";
import "../../src/styles/globals.css";
import "../../src/styles/project-workspace.css";
import "./logo-creation-workspace-preview.css";
function Preview() {
  const session = useAccountSession();
  if (location.pathname === "/brand-board-layout-fixture") return <main style={{ height: "calc(100dvh - 64px)", overflow: "auto", padding: 16, display: "flex", flexDirection: "column" }} aria-label="Brand board layout fixture"><header style={{ height: 46, flexShrink: 0, marginBottom: 12 }}><h1>Brand board</h1></header><BrandBoardSystem name="Glide" logoType="wordmark" choices={inspirationCatalog.filter(row => row.slug === "dropbox-blue-symbol" || row.slug === "cardless-red-logo").map(row => ({ referenceId: row.id, ensemble: true, elements: [] }) as unknown as InspirationChoice)} logo={<span style={{ fontSize: 32, fontWeight: 600 }}>Glide</span>} /></main>;
  const projectId = location.pathname.match(/\/account\/([^/]+)\/logo/)?.[1];
  return <main style={{ maxWidth: 1140, margin: "auto", padding: 20 }}>
    <p>Local synthetic test only. No live provider, storage or charges.</p>
    <button type="button" onClick={session.refresh}>Recheck test account</button>
    <LogoCreationWorkspace projectId={projectId} mode={location.pathname.endsWith("/editor") ? "refine" : "setup"} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<AccountSessionProvider><Preview /></AccountSessionProvider>);
