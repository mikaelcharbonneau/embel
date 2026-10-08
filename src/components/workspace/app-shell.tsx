"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import { useLocalDrafts } from "./local-drafts";
import { AccountSessionProvider, useAccountSession } from "./account-session";
import { AccountAccess, AccountAccessNotice } from "./account-access";
import { GenerationActivity } from "./generation-activity";

const primary: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Home", icon: "home" }, { href: "/brands", label: "Brands", icon: "brands" },
];
const tools: { href: string; label: string; icon: IconName }[] = [
  { href: "/ideas", label: "Ideas", icon: "ideas" }, { href: "/names", label: "Names", icon: "names" }, { href: "/handles", label: "Handles", icon: "handles" },
  { href: "/domains", label: "Domains", icon: "domains" }, { href: "/trademarks", label: "Trademarks", icon: "trademarks" }, { href: "/assets", label: "Assets", icon: "assets" },
];

function SidebarContent({ close }: { close?: () => void }) {
  const pathname = usePathname();
  const { session } = useAccountSession();
  const navLink = (item: typeof primary[number]) => {
    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
    return <Link key={item.href} href={item.href} className={`nav-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} onClick={close}><Icon name={item.icon} size={19} /><span>{item.label}</span></Link>;
  };
  return <>
    <Link href="/" className="wordmark" aria-label="Fluid home" onClick={close}>fluid</Link>
    <nav className="sidebar-nav" aria-label="Main navigation"><div className="nav-group">{[...primary, ...tools].map(navLink)}</div></nav>
    <div className="sidebar-bottom">{navLink({ href: "/settings", label: "Settings", icon: "settings" })}<Link href="/settings" className="workspace-label" onClick={close}><span className="workspace-avatar"><Icon name="user" size={18} /></span><div><strong>My workspace</strong><span>{session.status === "ready" ? "Personal account" : "Browser workspace"}</span></div></Link></div>
  </>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return <AccountSessionProvider><WorkspaceShell>{children}</WorkspaceShell></AccountSessionProvider>;
}

function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { storage } = useLocalDrafts();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDialogElement>(null);
  const pageLabel = [...primary, ...tools, { href: "/settings", label: "Settings" }, { href: "/sign-in", label: "Sign in" }].find((item) => item.href !== "/" && pathname.startsWith(item.href))?.label ?? "Home";

  useEffect(() => {
    const dialog = menuRef.current;
    if (menuOpen && dialog && !dialog.open) dialog.showModal();
    if (!menuOpen && dialog?.open) dialog.close();
  }, [menuOpen]);

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar"><SidebarContent /></aside>
    <dialog className="mobile-menu" ref={menuRef} onCancel={() => setMenuOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setMenuOpen(false); }} aria-label="Navigation"><button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMenuOpen(false)}><Icon name="close" /></button><SidebarContent close={() => setMenuOpen(false)} /></dialog>
    <div className="workspace-main">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu-trigger" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Icon name="menu" /></button><span>{pageLabel}</span></div><div className="topbar-account-actions"><GenerationActivity /><AccountAccess /></div></header>
      <AccountAccessNotice />
      {storage === "unavailable" && <div className="storage-alert" role="alert">Browser storage is unavailable. Your changes will only stay in this tab until you close or reload it.</div>}
      {storage === "invalid" && <div className="storage-alert" role="alert">Saved drafts could not be read. Start a new draft or clear local data in Settings.</div>}
      <main id="main-content" tabIndex={-1}>{children}</main>
    </div>
  </div>;
}
