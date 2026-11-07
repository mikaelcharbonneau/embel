"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AppMark } from "@/components/ui/app-mark";
import { Icon, type IconName } from "@/components/ui/icon";
import styles from "./journey.module.css";

/** Tools also carry an icon and a one-line description for the Tools menu. */
export type NavItem = { href: string; label: string; icon?: IconName; description?: string };

export function isActiveHref(href: string, pathname: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The floating pill. Its frame and the account control stay mounted while the
 * middle switches between the main navigation and a project's bar, so an open
 * account menu or nested dialog survives moving in and out of a project. */
export function NavFrame({ variant, account, children }: { variant: "main" | "project"; account?: ReactNode; children: ReactNode }) {
  return <header className={styles.navWrap}>
    <div className={`${styles.capsule} ${variant === "main" ? styles.navCapsule : styles.projectCapsule}`}>
      {children}
      {account && <><span className={`${styles.sep} ${styles.accountSep}`} aria-hidden="true" /><div className={styles.end}>{account}</div></>}
    </div>
  </header>;
}

/** Global navigation: brand, main pages and the Tools menu. */
export function MainNavContent({ pathname, items, tools = [] }: { pathname: string; items: readonly NavItem[]; tools?: readonly NavItem[] }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const descriptionPrefix = useId();
  const [open, setOpen] = useState(false);
  const close = (focus = false) => {
    if (menu.current) menu.current.open = false;
    if (focus) menu.current?.querySelector("summary")?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const toolActive = tools.some(item => isActiveHref(item.href, pathname));
  return <nav className={styles.mainNav} aria-label="Main navigation">
    <Link href="/" className={styles.brand} aria-label="Embel home"><AppMark /><span aria-hidden="true">Embel</span></Link>
    <span className={styles.sep} aria-hidden="true" />
    <ul className={styles.navList}>
      {items.map(item => <li key={item.href}><Link href={item.href} className={styles.navLink} aria-current={isActiveHref(item.href, pathname) ? "page" : undefined}>{item.label}</Link></li>)}
      {tools.length > 0 && <li>
        <details ref={menu} className={styles.tools} onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => { if (event.key === "Escape" && menu.current?.open) { event.preventDefault(); close(true); } }}>
          <summary className={styles.navLink} aria-current={toolActive ? "page" : undefined}>Tools<Icon name="chevron" size={12} style={{ transform: "rotate(90deg)" }} /></summary>
          <ul className={`${styles.menu} tools-menu`}>
            {tools.map(item => {
              // The tool's name stays its accessible name; the line below describes it.
              const descriptionId = item.description ? `${descriptionPrefix}${item.href.replace(/\W/g, "")}` : undefined;
              return <li key={item.href}><Link href={item.href} className="tools-menu-item" aria-label={descriptionId ? item.label : undefined} aria-describedby={descriptionId} aria-current={isActiveHref(item.href, pathname) ? "page" : undefined} onClick={() => close()}>
                {item.icon && <span className="tools-menu-icon" aria-hidden="true"><Icon name={item.icon} size={18} /></span>}
                <span className="tools-menu-text"><span className="tools-menu-label">{item.label}</span>{item.description && <span className="tools-menu-description" id={descriptionId}>{item.description}</span>}</span>
              </Link></li>;
            })}
          </ul>
        </details>
      </li>}
    </ul>
  </nav>;
}

/** Global navigation as one floating pill: brand, main pages, Tools menu, account. */
export function FloatingNav({ pathname, items, tools = [], account }: { pathname: string; items: readonly NavItem[]; tools?: readonly NavItem[]; account?: ReactNode }) {
  return <NavFrame variant="main" account={account}><MainNavContent pathname={pathname} items={items} tools={tools} /></NavFrame>;
}
