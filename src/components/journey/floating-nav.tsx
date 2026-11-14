"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { EmbelMark } from "@/components/ui/icon";
import styles from "./journey.module.css";

export type NavItem = { href: string; label: string };

function isActiveHref(href: string, pathname: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The floating pill. Its frame and the account control stay mounted while the
 * middle switches between the main navigation and a project's bar, so an open
 * account menu or nested dialog survives moving in and out of a project. */
export function NavFrame({
  variant,
  account,
  children,
}: {
  variant: "main" | "project";
  account?: ReactNode;
  children: ReactNode;
}) {
  // The main pill is the design system's e-nav; the project bar keeps its own layout until the
  // brand conversation is rebuilt on the Workspace.
  if (variant === "main")
    return (
      <header className="e-nav-wrap">
        <div className="e-nav">
          {children}
          {account && (
            <>
              <span className="e-nav__sep" aria-hidden="true" />
              <div className="e-nav__account">{account}</div>
            </>
          )}
        </div>
      </header>
    );
  return (
    <header className={styles.navWrap}>
      <div className={`${styles.capsule} ${styles.projectCapsule}`}>
        {children}
        {account && (
          <>
            <span className={`${styles.sep} ${styles.accountSep}`} aria-hidden="true" />
            <div className={styles.end}>{account}</div>
          </>
        )}
      </div>
    </header>
  );
}

/** Global navigation: brand and main pages. */
export function MainNavContent({ pathname, items }: { pathname: string; items: readonly NavItem[] }) {
  return (
    <nav className="app-nav" aria-label="Main navigation">
      <Link href="/" className="e-nav__brand" aria-label="Embel home">
        <EmbelMark />
        <span className="e-nav__label" aria-hidden="true" translate="no">
          Embel
        </span>
      </Link>
      <span className="e-nav__sep" aria-hidden="true" />
      <ul className="app-nav">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="e-nav__item"
              aria-current={isActiveHref(item.href, pathname) ? "page" : undefined}
            >
              <span className="e-nav__label">{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Global navigation as one floating pill: brand, main pages, account. */
export function FloatingNav({
  pathname,
  items,
  account,
}: {
  pathname: string;
  items: readonly NavItem[];
  account?: ReactNode;
}) {
  return (
    <NavFrame variant="main" account={account}>
      <MainNavContent pathname={pathname} items={items} />
    </NavFrame>
  );
}
