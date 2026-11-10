import Link from "next/link";
import { createRoot } from "react-dom/client";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { ProjectsWorkspace } from "@/components/workspace/projects-workspace";
import { HomeRecentBrands } from "@/components/workspace/home-recent-brands";
import "@/styles/globals.css";
import "@/styles/home-concept.css";
import "./project-deletion-preview.css";

function Preview() {
  const { refresh } = useAccountSession();
  const home = window.location.pathname === "/";
  return (
    <>
      <header className="fixture-header">
        <span>Synthetic project deletion fixture · no live data</span>
        <nav aria-label="Fixture navigation">
          <Link href="/brands">Projects fixture</Link>
          <Link href="/">Home fixture</Link>
          <button type="button" onClick={refresh}>
            Recheck fixture account
          </button>
        </nav>
      </header>
      <main className={home ? "fixture-home" : "fixture-projects"}>
        {home ? (
          <HomeRecentBrands />
        ) : (
          <ProjectsWorkspace
            state={new URLSearchParams(window.location.search).get("state") === "deleted" ? "deleted" : "active"}
          />
        )}
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <AccountSessionProvider>
    <Preview />
  </AccountSessionProvider>,
);
