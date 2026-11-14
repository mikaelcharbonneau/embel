"use client";

import { usePathname, useSelectedLayoutSegment, useSelectedLayoutSegments } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { ToastProvider } from "@/components/ui/toast";
import { MainNavContent, NavFrame, type NavItem } from "@/components/journey/floating-nav";
import { ProjectBarContent, ProjectMenu } from "@/components/journey/project-capsule";
import { ProjectHeaderContext, projectDocumentTitle, type ProjectHeader } from "@/components/journey/project-header";
import { AccountSessionProvider, useAccountSession } from "./account-session";
import { AccountProfileProvider, useAccountProfile } from "./account-profile-provider";
import { AccountAccessNotice, useSignOutFlow } from "./account-access";
import { ActivityDialog } from "./generation-activity";
import { preparePromptForSignIn } from "./prompt-recovery";
import { creditsLeft, nextCreditsDate, planName, useBillingSummary } from "@/components/billing/use-billing-summary";
import { SignedOutActions } from "@/components/auth/signed-out-actions";
import { OutOfCreditsPrompt } from "@/components/billing/out-of-credits-prompt";

// Library is the existing /assets page under the redesign's name.
const primary: NavItem[] = [
  { href: "/", label: "Home", icon: "house" },
  { href: "/brands", label: "Projects", icon: "folder" },
  { href: "/assets", label: "Library", icon: "library" },
];

export function AppShell({ children, auth }: { children: React.ReactNode; auth: React.ReactNode }) {
  return (
    <AccountSessionProvider>
      <AccountProfileProvider>
        <ToastProvider>
          <WorkspaceShell>{children}</WorkspaceShell>
          {auth}
        </ToastProvider>
      </AccountProfileProvider>
    </AccountSessionProvider>
  );
}

/** One floating pill for every page: brand, main pages and the account
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
  const pathname = intercepted
    ? `/${backgroundSegments.filter((segment) => !segment.startsWith("(")).join("/")}`
    : currentPathname;
  const [moreBelow, setMoreBelow] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const isHome = pathname === "/";
  const projectWorkspace = /^\/brands\/(?:account\/)?[0-9a-f-]{36}(?:\/|$)/i.test(pathname);
  const usesBottomFade = isHome;
  const accountProjectId = /^\/brands\/account\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname)?.[1]?.toLowerCase();
  // Until the project page reports its header, show the bar in its loading state
  // rather than flashing the global navigation. A project that can't be opened gets the app's navigation back.
  const header =
    accountProjectId && session.status === "ready"
      ? projectHeader?.projectId === accountProjectId
        ? projectHeader.unavailable
          ? null
          : projectHeader
        : { projectId: accountProjectId, projectName: "", steps: [], saveState: null }
      : null;
  const account = <WorkspaceAccount pathname={currentPathname} />;
  const documentTitle = header ? projectDocumentTitle(header) : null;
  useBrandDocumentTitle(documentTitle);
  // Page classes scope each route's existing layout rules.
  const pageClass = projectWorkspace
    ? "concept-project-workspace"
    : pathname === "/sign-in" || pathname === "/sign-up"
      ? "concept-sign-in"
      : isHome
        ? "concept-home"
        : pathname === "/settings"
          ? "concept-settings"
          : pathname === "/assets"
            ? "concept-assets"
            : pathname === "/brands"
              ? "concept-projects"
              : "";

  useEffect(() => {
    const main = mainRef.current;
    if (!usesBottomFade || !main) return;
    const measure = () => setMoreBelow(main.scrollHeight - main.clientHeight - main.scrollTop > 2);
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    if (main.firstElementChild) observer.observe(main.firstElementChild);
    main.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      main.removeEventListener("scroll", measure);
    };
  }, [usesBottomFade, pathname]);

  return (
    <div className={`app-shell concept-shell ${pageClass}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="workspace-main">
        <NavFrame variant={header ? "project" : "main"} account={account}>
          {header ? (
            <ProjectBarContent
              projectName={header.projectName}
              projectControl={header.projectName ? <ProjectMenu projectName={header.projectName} /> : undefined}
              steps={header.steps}
              saveState={header.saveState}
            />
          ) : (
            <MainNavContent pathname={pathname} items={primary} />
          )}
        </NavFrame>
        <AccountAccessNotice />
        <ProjectHeaderContext.Provider value={setProjectHeader}>
          <main id="main-content" ref={mainRef} tabIndex={-1}>
            {children}
          </main>
        </ProjectHeaderContext.Provider>
        {isHome && moreBelow && <div className="home-bottom-fade" aria-hidden="true" />}
      </div>
      {session.status === "ready" && <OutOfCreditsPrompt pathname={pathname} />}
    </div>
  );
}

/** Names the tab after the brand and its step while a brand page is open. The route's own title can be written again
 * after this runs (metadata streams in), so a change to <head> puts the brand's title back; leaving the brand restores
 * the route's title. */
function useBrandDocumentTitle(title: string | null) {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    const apply = () => {
      if (document.title !== title) document.title = title;
    };
    apply();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(apply);
    observer?.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      observer?.disconnect();
      if (document.title === title) document.title = previous;
    };
  }, [title]);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length ? (parts[0]![0]! + (parts.length > 1 ? parts.at(-1)![0]! : "")).toUpperCase() : null;
}

/** Signed out, the pill offers the two ways in. Otherwise it holds the account
 * menu, which also covers checking, signing in and sign-out recovery. */
function WorkspaceAccount({ pathname }: { pathname: string }) {
  const { session } = useAccountSession();
  return session.status === "signed_out" ? (
    <SignedOutActions placement="nav" />
  ) : (
    <WorkspaceAccountMenu pathname={pathname} />
  );
}

function WorkspaceAccountMenu({ pathname }: { pathname: string }) {
  const { session, refresh, signingIn, signingUp, signingOut, signOutError } = useAccountSession();
  const profile = useAccountProfile();
  const billing = useBillingSummary();
  const signOutFlow = useSignOutFlow();
  const [activityOpen, setActivityOpen] = useState(false);
  const ready = session.status === "ready";
  const checking = session.status === "checking" || (ready && Boolean(profile?.busy) && !profile?.workspace);
  const name = ready ? (profile?.workspace?.saved.values.fullName.trim() ?? "") : "";
  const email = ready ? (profile?.workspace?.saved.email ?? "") : "";
  const monogram = ready && !checking ? (initials(name) ?? (email ? email[0]!.toUpperCase() : null)) : null;
  const checkFailed = (session.status === "error" || session.status === "unavailable") && !signingIn && !signingOut;
  const outOfCredits = billing.status === "ready" && creditsLeft(billing.summary) === 0;

  const summary = signingIn ? (
    <span role="status">{signingUp ? "Creating account…" : "Signing in…"}</span>
  ) : checking ? (
    <span role="status">Checking your account…</span>
  ) : ready ? (
    <>
      {email && <span className="e-muted">{email}</span>}
      {billing.status === "ready" ? (
        <>
          <span className="e-menu__summary-title">{planName(billing.summary)}</span>
          <span className="e-tabular">
            {creditsLeft(billing.summary).toLocaleString("en-US")} credits left this month
          </span>
          {outOfCredits && nextCreditsDate(billing.summary) && (
            <span>New credits arrive on {nextCreditsDate(billing.summary)}</span>
          )}
        </>
      ) : billing.status === "failed" ? (
        <span>Your plan can’t be shown right now.</span>
      ) : (
        <span role="status">Checking your plan…</span>
      )}
    </>
  ) : signOutError ? (
    <span>Sign-out didn’t finish. Try again, or check your account.</span>
  ) : (
    <span>Your account couldn’t be checked. Check your connection and try again.</span>
  );

  const signOutRow: MenuItem = {
    kind: "action",
    label: signingOut ? "Signing out…" : signOutError ? "Retry sign-out" : "Sign out",
    icon: "log-out",
    disabled: signingOut,
    onSelect: () => void signOutFlow.start(),
  };
  const items: MenuItem[] = ready
    ? [
        ...(outOfCredits ? [{ kind: "link", label: "See plans", icon: "credit-card", href: "/plans" } as const] : []),
        ...(outOfCredits ? [{ kind: "separator" } as const] : []),
        { kind: "link", label: "Settings", icon: "settings", href: "/settings" },
        ...(outOfCredits ? [] : [{ kind: "link", label: "Plans", icon: "credit-card", href: "/plans" } as const]),
        { kind: "action", label: "Activity", icon: "clock", onSelect: () => setActivityOpen(true) },
        { kind: "separator" },
        signOutRow,
      ]
    : [
        ...(checkFailed
          ? [{ kind: "action", label: "Check account", icon: "refresh-cw", onSelect: refresh } as const]
          : []),
        ...(signingOut || signOutError ? [signOutRow] : []),
        ...(checkFailed && !signOutError
          ? [
              {
                kind: "link",
                label: "Sign in",
                icon: "arrow-right",
                href: "/sign-in",
                onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
                  if (!preparePromptForSignIn()) event.preventDefault();
                },
              } as const,
            ]
          : []),
      ];

  return (
    <>
      <Menu
        closeOn={pathname}
        summary={summary}
        items={items}
        trigger={(props) => (
          <button
            {...props}
            type="button"
            className="e-avatar"
            data-account-menu-trigger=""
            aria-label={checking ? "Account menu, checking your account" : "Account menu"}
            aria-busy={checking || undefined}
          >
            {monogram ?? <Icon name="user" size="sm" />}
          </button>
        )}
      />
      {activityOpen && <ActivityDialog onClose={() => setActivityOpen(false)} />}
      {signOutFlow.dialog}
    </>
  );
}
