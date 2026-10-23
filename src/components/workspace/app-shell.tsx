"use client";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";

import Link from "next/link";
import { usePathname, useSelectedLayoutSegment, useSelectedLayoutSegments } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import { AccountSessionProvider, useAccountSession } from "./account-session";
import { AccountProfileProvider, useAccountProfile } from "./account-profile-provider";
import { AccountAccess, AccountAccessNotice } from "./account-access";
import { GenerationActivity } from "./generation-activity";
import { useNamesStore } from "@/components/naming/use-names-store";
import { AppMark } from "@/components/ui/app-mark";

const primary: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Home", icon: "home" }, { href: "/brands", label: "Projects", icon: "brands" },
  { href: "/assets", label: "Assets", icon: "assets" },
];
const tools: { href: string; label: string; icon: IconName }[] = [
  { href: "/ideas", label: "Ideas", icon: "ideas" }, { href: "/names", label: "Names", icon: "names" }, { href: "/handles", label: "Handles", icon: "handles" },
  { href: "/domains", label: "Domains", icon: "domains" }, { href: "/trademarks", label: "Trademarks", icon: "trademarks" },
];

function SidebarContent({ close, concept = false, pathname }: { close?: () => void; concept?: boolean; pathname: string }) {
  const navLink = (item: typeof primary[number]) => {
    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
    // Shell artwork is route-independent. Only the active link styling changes;
    // navigating must not replace every icon with a new image resource.
    return <Link key={item.href} href={item.href} className={`nav-link ${active ? "active" : ""}`} aria-label={item.label} title={item.label} aria-current={active ? "page" : undefined} onClick={close}><Icon name={item.icon} size={20} /><span>{item.label}</span></Link>;
  };
  return <>
    <Link href="/" className={concept ? "app-mark" : "wordmark"} aria-label="Embel home" onClick={close}><AppMark /></Link>
    <nav className="sidebar-nav" aria-label="Main navigation">{concept ? <><div className="nav-group">{primary.map(navLink)}</div><div className="nav-group workspace-tools">{tools.map(navLink)}</div></> : <div className="nav-group">{[...primary, ...tools].map(navLink)}</div>}</nav>
    <div className="sidebar-bottom">{navLink({ href: "/settings", label: "Settings", icon: "settings" })}</div>
  </>;
}

export function AppShell({ children, auth }: { children: React.ReactNode; auth: React.ReactNode }) {
  return <AccountSessionProvider><AccountProfileProvider><WorkspaceShell>{children}</WorkspaceShell>{auth}</AccountProfileProvider></AccountSessionProvider>;
}

function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const currentPathname = usePathname();
  const authSegment = useSelectedLayoutSegment("auth");
  const backgroundSegments = useSelectedLayoutSegments();
  const intercepted = ["(.)sign-in", "sign-in", "(.)sign-up", "sign-up"].includes(authSegment ?? "");
  // The children slot retains the underlying route during intercepted navigation.
  const pathname = intercepted ? `/${backgroundSegments.filter(segment => !segment.startsWith("(")).join("/")}` : currentPathname;
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [moreBelow, setMoreBelow] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const isHome = pathname === "/";
  const isNewProject = pathname === "/brands/new";
  const isNewLogo = pathname === "/brands/logo/new";
  const ideaId = /^\/ideas\/([^/]+)$/.exec(pathname)?.[1];
  const projectWorkspace = /^\/brands\/(?:account\/)?[0-9a-f-]{36}(?:\/|$)/i.test(pathname);
  const usesConceptShell = isNewProject || isNewLogo || projectWorkspace || (pathname === "/sign-in" || pathname === "/sign-up") || pathname === "/settings" || pathname === "/trademarks" || pathname === "/assets" || pathname === "/brands" || isHome || pathname === "/ideas" || Boolean(ideaId) || pathname === "/domains" || pathname === "/handles" || pathname === "/names";
  const usesBottomFade = isHome || Boolean(ideaId);
  const menuRef = useRef<HTMLDialogElement>(null);
  const pageLabel = [...primary, ...tools, { href: "/settings", label: "Settings" }, { href: "/sign-in", label: "Sign in" }, { href: "/sign-up", label: "Create account" }].find((item) => item.href !== "/" && pathname.startsWith(item.href))?.label ?? "Home";

  useEffect(() => {
    const dialog = menuRef.current;
    if (menuOpen && dialog && !dialog.open) dialog.showModal();
    if (!menuOpen && dialog?.open) dialog.close();
  }, [menuOpen]);

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

  return <div className={`app-shell ${usesConceptShell ? "concept-shell" : ""} ${projectWorkspace ? "concept-project-workspace" : (pathname === "/sign-in" || pathname === "/sign-up") ? "concept-sign-in" : isHome || isNewProject ? "concept-home" : ideaId ? "concept-idea-detail" : pathname === "/ideas" ? "concept-ideas" : pathname === "/domains" ? "concept-domains" : pathname === "/handles" ? "concept-handles" : pathname === "/names" ? "concept-names" : pathname === "/settings" ? "concept-settings" : pathname === "/trademarks" ? "concept-trademarks" : pathname === "/assets" ? "concept-assets" : pathname === "/brands" ? "concept-projects" : ""} ${expanded ? "navigation-expanded" : "navigation-collapsed"}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar"><SidebarContent pathname={pathname} concept={usesConceptShell} /></aside>
    <dialog className="mobile-menu" ref={menuRef} onCancel={() => setMenuOpen(false)} onClick={(event) => { if (isDialogBackdropClick(event)) setMenuOpen(false); }} aria-label="Navigation"><button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMenuOpen(false)}><Icon name="close" /></button><SidebarContent pathname={pathname} close={() => setMenuOpen(false)} /></dialog>
    <div className="workspace-main">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu-trigger" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>{usesConceptShell && <><button className="icon-button workspace-sidebar-toggle" aria-label={expanded ? "Collapse navigation" : "Expand navigation"} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Icon name="chevron" size={16} /></button><span className="workspace-breadcrumb-root">My workspace</span><span className="workspace-breadcrumb-slash" aria-hidden="true">/</span></>}{ideaId ? <IdeaBreadcrumb ideaId={ideaId} /> : pathname === "/names" ? <NamesBreadcrumb /> : <span>{pageLabel}</span>}</div>{usesConceptShell ? <WorkspaceAccountMenu pathname={currentPathname} /> : <div className="topbar-account-actions"><GenerationActivity /><AccountAccess /></div>}</header>
      <AccountAccessNotice />
      <main id="main-content" ref={mainRef} tabIndex={-1}>{children}</main>
      {isHome && moreBelow && <div className="home-bottom-fade" aria-hidden="true" />}
      {ideaId && moreBelow && <div className="idea-bottom-fade" aria-hidden="true" />}
    </div>
  </div>;
}

function NamesBreadcrumb() {
  const { data } = useNamesStore();
  const label = data.ui.tab === "assistant" ? "AI Assistant" : data.ui.tab[0]!.toUpperCase() + data.ui.tab.slice(1);
  return <span>Names / {label}</span>;
}

function IdeaBreadcrumb({ ideaId }: { ideaId: string }) {
  const { session, ideaDrafts } = useAccountSession();
  const title = useSyncExternalStore(ideaDrafts.subscribe, () => {
    if (session.status !== "ready") return null;
    const idea = ideaDrafts.get(session.userId, ideaId.toLowerCase());
    return idea?.generation === session.generation ? idea.content.title : null;
  }, () => null);
  return <div className="idea-breadcrumb"><Link href="/ideas" aria-label="Back to ideas">Ideas</Link><span className="idea-breadcrumb-divider" aria-hidden="true">/</span><span className="idea-breadcrumb-title">{title || "Idea detail"}</span></div>;
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
  return <details className="workspace-account-menu" ref={menu}><summary aria-label="Account menu" aria-busy={checking}><span className="workspace-account-label" aria-busy={checking}>{checking ? <><span className="workspace-account-placeholder" aria-hidden="true" /><span className="sr-only" role="status">Checking account…</span></> : label}</span><span className="workspace-account-avatar"><Icon name="user" size={16} /></span></summary><div className="workspace-account-panel" role="group" aria-label="Account actions">
      <div className="workspace-account-identity"><strong>{checking ? "Checking your account…" : label}</strong><span>{session.status === "ready" ? profile?.workspace?.saved.email || "Personal workspace" : session.status === "signed_out" ? "Sign in to save and continue your brands." : "Verify your connection to access saved work."}</span></div>
      {session.status === "ready" && <div className="workspace-account-links"><Link href="/settings"><Icon name="settings" size={18} /><span>Account settings</span></Link><GenerationActivity labeled /></div>}
      <AccountAccess menu />
    </div></details>;
}
