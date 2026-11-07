"use client";

import { usePathname, useSelectedLayoutSegment, useSelectedLayoutSegments } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { MainNavContent, NavFrame, type NavItem } from "@/components/journey/floating-nav";
import { ProjectBarContent, ProjectMenu } from "@/components/journey/project-capsule";
import { ProjectHeaderContext, type ProjectHeader } from "@/components/journey/project-header";
import { AccountSessionProvider, useAccountSession } from "./account-session";
import { AccountProfileProvider, useAccountProfile } from "./account-profile-provider";
import { AccountAccess, AccountAccessNotice } from "./account-access";
import { GenerationActivity } from "./generation-activity";
import { SignedOutActions } from "@/components/auth/signed-out-actions";

// Library is the existing /assets page under the redesign's name.
const primary: NavItem[] = [{ href: "/", label: "Home" }, { href: "/brands", label: "Projects" }, { href: "/assets", label: "Library" }];
const tools: NavItem[] = [
  { href: "/ideas", label: "Ideas", icon: "ideas", description: "Save ideas for later" },
  { href: "/names", label: "Names", icon: "names", description: "Build and compare name ideas" },
  { href: "/handles", label: "Handles", icon: "handles", description: "Draft social handles" },
  { href: "/domains", label: "Domains", icon: "domains", description: "Search domain names" },
  { href: "/trademarks", label: "Trademarks", icon: "trademarks", description: "Prepare a trademark search" },
];

export function AppShell({ children, auth }: { children: React.ReactNode; auth: React.ReactNode }) {
  return <AccountSessionProvider><AccountProfileProvider><WorkspaceShell>{children}</WorkspaceShell>{auth}</AccountProfileProvider></AccountSessionProvider>;
}

/** One floating pill for every page: brand, main pages, Tools and the account
 * menu. Inside a signed-in project it becomes the project bar (name, journey
 * steps, save status). The page area below it stays the scroll container. */
function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const currentPathname = usePathname();
  const { session } = useAccountSession();
  const [projectHeader, setProjectHeader] = useState<ProjectHeader | null>(null);
  const authSegment = useSelectedLayoutSegment("auth");
  const backgroundSegments = useSelectedLayoutSegments();
  const intercepted = ["(.)sign-in", "sign-in", "(.)sign-up", "sign-up"].includes(authSegment ?? "");
  // The children slot retains the underlying route during intercepted navigation.
  const pathname = intercepted ? `/${backgroundSegments.filter(segment => !segment.startsWith("(")).join("/")}` : currentPathname;
  const [moreBelow, setMoreBelow] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const isHome = pathname === "/";
  const ideaId = /^\/ideas\/([^/]+)$/.exec(pathname)?.[1];
  const projectWorkspace = /^\/brands\/(?:account\/)?[0-9a-f-]{36}(?:\/|$)/i.test(pathname);
  const usesBottomFade = isHome || Boolean(ideaId);
  const accountProjectId = /^\/brands\/account\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname)?.[1]?.toLowerCase();
  // Until the project page reports its header, show the bar in its loading state
  // rather than flashing the global navigation.
  const header = accountProjectId && session.status === "ready"
    ? projectHeader?.projectId === accountProjectId ? projectHeader : { projectId: accountProjectId, projectName: "", steps: [], saveState: null }
    : null;
  const account = <WorkspaceAccount pathname={currentPathname} />;
  // Page classes scope each route's existing layout rules.
  const pageClass = projectWorkspace ? "concept-project-workspace" : (pathname === "/sign-in" || pathname === "/sign-up") ? "concept-sign-in"
    : isHome ? "concept-home" : ideaId ? "concept-idea-detail" : pathname === "/ideas" ? "concept-ideas"
    : pathname === "/domains" ? "concept-domains" : pathname === "/handles" ? "concept-handles" : pathname === "/names" ? "concept-names"
    : pathname === "/settings" ? "concept-settings" : pathname === "/trademarks" ? "concept-trademarks" : pathname === "/assets" ? "concept-assets"
    : pathname === "/brands" ? "concept-projects" : "";

  useEffect(() => {
    const main = mainRef.current;
    if (!usesBottomFade || !main) return;
    const measure = () => setMoreBelow(main.scrollHeight - main.clientHeight - main.scrollTop > 2);
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    if (main.firstElementChild) observer.observe(main.firstElementChild);
    main.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => { observer.disconnect(); main.removeEventListener("scroll", measure); };
  }, [usesBottomFade, pathname]);

  return <div className={`app-shell concept-shell ${pageClass}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <div className="workspace-main">
      <NavFrame variant={header ? "project" : "main"} account={account}>
        {header
          ? <ProjectBarContent projectName={header.projectName} projectControl={header.projectName ? <ProjectMenu projectName={header.projectName} /> : undefined}
            steps={header.steps} saveState={header.saveState} />
          : <MainNavContent pathname={pathname} items={primary} tools={tools} />}
      </NavFrame>
      <AccountAccessNotice />
      <ProjectHeaderContext.Provider value={setProjectHeader}>
        <main id="main-content" ref={mainRef} tabIndex={-1}>{children}</main>
      </ProjectHeaderContext.Provider>
      {isHome && moreBelow && <div className="home-bottom-fade" aria-hidden="true" />}
      {ideaId && moreBelow && <div className="idea-bottom-fade" aria-hidden="true" />}
    </div>
  </div>;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length ? (parts[0]![0]! + (parts.length > 1 ? parts.at(-1)![0]! : "")).toUpperCase() : null;
}

/** Signed out, the pill offers the two ways in. Otherwise it holds the account
 * menu, which also covers checking, signing in and sign-out recovery. */
function WorkspaceAccount({ pathname }: { pathname: string }) {
  const { session } = useAccountSession();
  return session.status === "signed_out" ? <SignedOutActions placement="nav" /> : <WorkspaceAccountMenu pathname={pathname} />;
}

function WorkspaceAccountMenu({ pathname }: { pathname: string }) {
  const { session, signOutError } = useAccountSession();
  const profile = useAccountProfile();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const node = menu.current;
    if (!node) return;
    const modalOpen = () => Boolean(document.querySelector("dialog[open]"));
    const outsidePointer = (event: PointerEvent) => {
      if (!node.open || modalOpen() || !(event.target instanceof Node) || node.contains(event.target)) return;
      // Let the outside control receive its normal pointer action and focus.
      node.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !node.open || modalOpen()) return;
      event.preventDefault(); node.open = false; node.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outsidePointer);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outsidePointer);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => { if (menu.current) menu.current.open = false; }, [pathname]);
  const ready = session.status === "ready";
  const checking = session.status === "checking" || (ready && Boolean(profile?.busy) && !profile?.workspace);
  const name = ready ? profile?.workspace?.saved.values.fullName.trim() ?? "" : "";
  const email = ready ? profile?.workspace?.saved.email ?? "" : "";
  const label = ready ? name || email || "My account" : "Account";
  const monogram = ready && !checking ? initials(name) ?? (email ? email[0]!.toUpperCase() : null) : null;
  // The pill shows only the avatar; the name stays available to assistive
  // technology and at the top of the open panel.
  return <details className="workspace-account-menu" ref={menu}><summary aria-label="Account menu" aria-busy={checking}><span className="workspace-account-label sr-only" aria-busy={checking}>{checking ? <span role="status">Checking account…</span> : label}</span><span className="workspace-account-avatar" aria-hidden="true">{monogram ?? <Icon name="user" size={16} />}</span></summary><div className="workspace-account-panel" role="group" aria-label="Account actions">
      <div className="workspace-account-identity">{checking ? <strong>Checking your account…</strong> : ready ? <><strong>{label}</strong>{name && email && <span>{email}</span>}</> : <><strong>Account</strong><span>{signOutError ? "Sign-out didn’t finish. Try again, or check your account." : "Your account couldn’t be checked. Check your connection and try again."}</span></>}</div>
      {ready && <div className="workspace-account-links"><Link href="/settings"><Icon name="settings" size={18} /><span>Account settings</span></Link><GenerationActivity labeled /></div>}
      <AccountAccess menu />
    </div></details>;
}
