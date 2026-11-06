"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppMark } from "@/components/ui/app-mark";
import { Icon } from "@/components/ui/icon";
import styles from "./journey.module.css";

export type NavItem = { href: string; label: string };

export function isActiveHref(href: string, pathname: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** Global navigation as one floating pill: brand, main pages, Tools menu, account. */
export function FloatingNav({ pathname, items, tools = [], account }: { pathname: string; items: readonly NavItem[]; tools?: readonly NavItem[]; account?: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
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
  return <header className={styles.navWrap}>
    <nav className={styles.capsule} aria-label="Main navigation">
      <Link href="/" className={styles.brand} aria-label="Embel home"><AppMark /><span aria-hidden="true">Embel</span></Link>
      <span className={styles.sep} aria-hidden="true" />
      <ul className={styles.navList}>
        {items.map(item => <li key={item.href}><Link href={item.href} className={styles.navLink} aria-current={isActiveHref(item.href, pathname) ? "page" : undefined}>{item.label}</Link></li>)}
        {tools.length > 0 && <li>
          <details ref={menu} className={styles.tools} onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => { if (event.key === "Escape" && menu.current?.open) { event.preventDefault(); close(true); } }}>
            <summary className={styles.navLink} aria-current={toolActive ? "page" : undefined}>Tools<Icon name="chevron" size={12} style={{ transform: "rotate(90deg)" }} /></summary>
            <ul className={styles.menu}>
              {tools.map(item => <li key={item.href}><Link href={item.href} aria-current={isActiveHref(item.href, pathname) ? "page" : undefined} onClick={() => close()}>{item.label}</Link></li>)}
            </ul>
          </details>
        </li>}
      </ul>
      {account && <><span className={styles.sep} aria-hidden="true" /><div className={styles.end}>{account}</div></>}
    </nav>
  </header>;
}
