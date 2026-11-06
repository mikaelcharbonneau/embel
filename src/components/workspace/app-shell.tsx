"use client";

import { usePathname, useSelectedLayoutSegment, useSelectedLayoutSegments } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { FloatingNav, type NavItem } from "@/components/journey/floating-nav";
import { AccountSessionProvider, useAccountSession } from "./account-session";
import { AccountProfileProvider, useAccountProfile } from "./account-profile-provider";
import { AccountAccess, AccountAccessNotice } from "./account-access";
import { GenerationActivity } from "./generation-activity";

// Library is the existing /assets page under the redesign's name.
const primary: NavItem[] = [{ href: "/", label: "Home" }, { href: "/brands", label: "Projects" }, { href: "/assets", label: "Library" }];
const tools: NavItem[] = [
  { href: "/ideas", label: "Ideas" }, { href: "/names", label: "Names" }, { href: "/handles", label: "Handles" },
  { href: "/domains", label: "Domains" }, { href: "/trademarks", label: "Trademarks" },
];

export function AppShell({ children, auth }: { children: React.ReactNode; auth: React.ReactNode }) {
  return <AccountSessionProvider><AccountProfileProvider><WorkspaceShell>{children}</WorkspaceShell>{auth}</AccountProfileProvider></AccountSessionProvider>;
}

/** One floating pill for every page: brand, main pages, Tools and the account
 * menu. The page area below it stays the scroll container. */
function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const currentPathname = usePathname();
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
  // Page classes scope each route's existing layout rules.
  const pageClass = projectWorkspace ? "concept-project-workspace" : (pathname === "/sign-in" || pathname === "/sign-up") ? "concept-sign-in"
    : isHome || pathname === "/brands/new" ? "concept-home" : ideaId ? "concept-idea-detail" : pathname === "/ideas" ? "concept-ideas"
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
      <FloatingNav pathname={pathname} items={primary} tools={tools} account={<WorkspaceAccountMenu pathname={currentPathname} />} />
      <AccountAccessNotice />
      <main id="main-content" ref={mainRef} tabIndex={-1}>{children}</main>
      {isHome && moreBelow && <div className="home-bottom-fade" aria-hidden="true" />}
      {ideaId && moreBelow && <div className="idea-bottom-fade" aria-hidden="true" />}
    </div>
  </div>;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length ? (parts[0]![0]! + (parts.length > 1 ? parts.at(-1)![0]! : "")).toUpperCase() : null;
}

function WorkspaceAccountMenu({ pathname }: { pathname: string }) {
  const { session } = useAccountSession();
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
  const checking = session.status === "checking" || (session.status === "ready" && Boolean(profile?.busy) && !profile?.workspace);
  const label = session.status === "ready" ? (profile?.workspace?.saved.values.fullName || "My account") : session.status === "signed_out" ? "Sign in" : "Account";
  const monogram = session.status === "ready" && !checking ? initials(profile?.workspace?.saved.values.fullName ?? "") : null;
  // Signed in, the pill shows only the avatar; the name stays available to
  // assistive technology and in the open panel.
  return <details className="workspace-account-menu" ref={menu}><summary aria-label="Account menu" aria-busy={checking}><span className={`workspace-account-label${session.status === "signed_out" ? "" : " sr-only"}`} aria-busy={checking}>{checking ? <span role="status">Checking account…</span> : label}</span><span className="workspace-account-avatar" aria-hidden="true">{monogram ?? <Icon name="user" size={16} />}</span></summary><div className="workspace-account-panel" role="group" aria-label="Account actions">
      <div className="workspace-account-identity"><strong>{checking ? "Checking your account…" : label}</strong><span>{session.status === "ready" ? profile?.workspace?.saved.email || "Personal workspace" : session.status === "signed_out" ? "Sign in to save and continue your brands." : "Verify your connection to access saved work."}</span></div>
      {session.status === "ready" && <div className="workspace-account-links"><Link href="/settings"><Icon name="settings" size={18} /><span>Account settings</span></Link><GenerationActivity labeled /></div>}
      <AccountAccess menu />
    </div></details>;
}
