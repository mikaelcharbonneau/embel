"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AppMark } from "@/components/ui/app-mark";
import styles from "./journey.module.css";

export type NavItem = { href: string; label: string };

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

/** Global navigation: brand and main pages. */
export function MainNavContent({ pathname, items }: { pathname: string; items: readonly NavItem[] }) {
  return <nav className={styles.mainNav} aria-label="Main navigation">
    <Link href="/" className={styles.brand} aria-label="Embel home"><AppMark /><span aria-hidden="true">Embel</span></Link>
    <span className={styles.sep} aria-hidden="true" />
    <ul className={styles.navList}>
      {items.map(item => <li key={item.href}><Link href={item.href} className={styles.navLink} aria-current={isActiveHref(item.href, pathname) ? "page" : undefined}>{item.label}</Link></li>)}
    </ul>
  </nav>;
}

/** Global navigation as one floating pill: brand, main pages, account. */
export function FloatingNav({ pathname, items, account }: { pathname: string; items: readonly NavItem[]; account?: ReactNode }) {
  return <NavFrame variant="main" account={account}><MainNavContent pathname={pathname} items={items} /></NavFrame>;
}
