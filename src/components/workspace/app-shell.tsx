"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import { useLocalDrafts } from "./local-drafts";
import { AccountSessionProvider, useAccountSession } from "./account-session";
import { AccountAccess, AccountAccessNotice } from "./account-access";
import { GenerationActivity } from "./generation-activity";
import { HandlesArtwork, type HandlesArtworkName } from "@/components/ui/handles-artwork";
import { NamesShellArtwork, type NamesShellArtworkName } from "@/components/ui/names-artwork";
import { useNamesStore } from "@/components/naming/use-names-store";
import { AppMark } from "@/components/ui/app-mark";

import { ProjectsShellArtwork, type ProjectsShellArtworkName } from "@/components/ui/projects-artwork";

const primary: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Home", icon: "home" }, { href: "/brands", label: "Projects", icon: "brands" },
  { href: "/assets", label: "Assets", icon: "assets" },
];
const tools: { href: string; label: string; icon: IconName }[] = [
  { href: "/ideas", label: "Ideas", icon: "ideas" }, { href: "/names", label: "Names", icon: "names" }, { href: "/handles", label: "Handles", icon: "handles" },
  { href: "/domains", label: "Domains", icon: "domains" }, { href: "/trademarks", label: "Trademarks", icon: "trademarks" },
];

function SidebarContent({ close, concept = false }: { close?: () => void; concept?: boolean }) {
  const pathname = usePathname();
  const { session } = useAccountSession();
  const navLink = (item: typeof primary[number]) => {
    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
    return <Link key={item.href} href={item.href} className={`nav-link ${active ? "active" : ""}`} aria-label={item.label} title={item.label} aria-current={active ? "page" : undefined} onClick={close}>{pathname === "/brands" ? <ProjectsShellArtwork name={item.icon as ProjectsShellArtworkName} /> : pathname === "/names" ? <NamesShellArtwork name={item.icon as NamesShellArtworkName} /> : pathname === "/handles" ? <HandlesArtwork name={item.icon as HandlesArtworkName} /> : <Icon name={item.icon} size={concept ? 20 : 19} />}<span>{item.label}</span></Link>;
  };
  return <>
    <Link href="/" className={concept ? "app-mark" : "wordmark"} aria-label="Fluid home" onClick={close}>{pathname === "/brands" ? <ProjectsShellArtwork name="mark" /> : pathname === "/names" ? <NamesShellArtwork name="mark" /> : pathname === "/handles" ? <HandlesArtwork name="mark" /> : <AppMark />}</Link>
    <nav className="sidebar-nav" aria-label="Main navigation">{concept ? <><div className="nav-group">{primary.map(navLink)}</div><div className="nav-group workspace-tools">{tools.map(navLink)}</div></> : <div className="nav-group">{[...primary, ...tools].map(navLink)}</div>}</nav>
    <div className="sidebar-bottom">{navLink({ href: "/settings", label: "Settings", icon: "settings" })}<Link href="/settings" className="workspace-label" aria-label="My workspace settings" title="My workspace" onClick={close}><span className="workspace-avatar"><Icon name="user" size={18} /></span><div><strong>My workspace</strong><span>{session.status === "ready" ? "Personal account" : "Browser workspace"}</span></div></Link></div>
  </>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return <AccountSessionProvider><WorkspaceShell>{children}</WorkspaceShell></AccountSessionProvider>;
}

function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { storage } = useLocalDrafts();
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [moreBelow, setMoreBelow] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const isHome = pathname === "/";
  const ideaId = /^\/ideas\/([^/]+)$/.exec(pathname)?.[1];
  const usesConceptShell = pathname === "/brands" || isHome || pathname === "/ideas" || Boolean(ideaId) || pathname === "/domains" || pathname === "/handles" || pathname === "/names";
  const usesBottomFade = isHome || Boolean(ideaId);
  const menuRef = useRef<HTMLDialogElement>(null);
  const pageLabel = [...primary, ...tools, { href: "/settings", label: "Settings" }, { href: "/sign-in", label: "Sign in" }].find((item) => item.href !== "/" && pathname.startsWith(item.href))?.label ?? "Home";

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

  return <div className={`app-shell ${usesConceptShell ? "concept-shell" : ""} ${isHome ? "concept-home" : ideaId ? "concept-idea-detail" : pathname === "/ideas" ? "concept-ideas" : pathname === "/domains" ? "concept-domains" : pathname === "/handles" ? "concept-handles" : pathname === "/names" ? "concept-names" : pathname === "/brands" ? "concept-projects" : ""} ${expanded ? "navigation-expanded" : "navigation-collapsed"}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar"><SidebarContent concept={usesConceptShell} /></aside>
    <dialog className="mobile-menu" ref={menuRef} onCancel={() => setMenuOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setMenuOpen(false); }} aria-label="Navigation"><button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMenuOpen(false)}><Icon name="close" /></button><SidebarContent close={() => setMenuOpen(false)} /></dialog>
    <div className="workspace-main">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu-trigger" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>{usesConceptShell && <><button className="icon-button workspace-sidebar-toggle" aria-label={expanded ? "Collapse navigation" : "Expand navigation"} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{pathname === "/brands" ? <ProjectsShellArtwork name="expand" /> : pathname === "/names" ? <NamesShellArtwork name="expand" /> : pathname === "/handles" ? <HandlesArtwork name="expand" /> : <Icon name="chevron" size={16} />}</button><span className="workspace-breadcrumb-root">My workspace</span><span className="workspace-breadcrumb-slash" aria-hidden="true">/</span></>}{ideaId ? <IdeaBreadcrumb ideaId={ideaId} /> : pathname === "/names" ? <NamesBreadcrumb /> : <span>{pageLabel}</span>}</div>{usesConceptShell ? <WorkspaceAccountMenu /> : <div className="topbar-account-actions"><GenerationActivity /><AccountAccess /></div>}</header>
      <AccountAccessNotice />
      {storage === "unavailable" && <div className="storage-alert" role="alert">Browser storage is unavailable. Your changes will only stay in this tab until you close or reload it.</div>}
      {storage === "invalid" && <div className="storage-alert" role="alert">Saved drafts could not be read. Start a new draft or clear local data in Settings.</div>}
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

function WorkspaceAccountMenu() {
  const { session } = useAccountSession();
  const menu = useRef<HTMLDetailsElement>(null);
  return <details className="workspace-account-menu" ref={menu} onKeyDown={event => {
    if (event.key === "Escape" && menu.current) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); }
  }}><summary aria-label="Account menu"><span>{session.status === "ready" ? "My account" : "Sign in"}</span><span className="workspace-account-avatar"><Icon name="user" size={16} /></span></summary><div className="workspace-account-panel"><AccountAccess /><GenerationActivity /></div></details>;
}
