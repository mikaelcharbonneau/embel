"use client";

import { useRef, useState } from "react";
import { useAccountSession } from "./account-session";
import { useSignOutFlow } from "./account-access";
import { preparePromptForSignIn } from "./prompt-recovery";
import { Button, ButtonLink } from "@/components/ui/button";
import { RecordedUsageSection } from "./recorded-usage";
import { AccountProfileEditor } from "./account-profile-editor";
import { AccountDataControls } from "./account-data-controls";
import { PlanCreditsCard } from "@/components/billing/plan-credits-card";

// Settings always opens on Account, so links to removed categories
// (for example ?category=security) land there.
const categories = [
  ["account", "Account"],
  ["usage", "Usage"],
] as const;
type Category = (typeof categories)[number][0];

export function SettingsWorkspace() {
  const [category, setCategory] = useState<Category>("account");
  const [usageVisited, setUsageVisited] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function selectCategory(next: Category) {
    if (next === "usage") setUsageVisited(true);
    setCategory(next);
  }
  function activate(index: number) {
    selectCategory(categories[index]![0]);
    tabs.current[index]?.focus();
  }
  return (
    <div className="settings-guided e-container e-page" data-category={category}>
      <header className="sg-heading e-stack e-stack--xs">
        <h1 className="sg-heading__title">Settings</h1>
        <p className="e-muted">Manage your account and see your usage.</p>
      </header>
      <div className="e-tabs sg-tabs" role="tablist" aria-label="Settings">
        {categories.map(([id, label], index) => (
          <button
            key={id}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            type="button"
            role="tab"
            className="e-tab"
            id={`settings-tab-${id}`}
            aria-controls={`settings-panel-${id}`}
            aria-selected={category === id}
            tabIndex={category === id ? 0 : -1}
            onClick={() => selectCategory(id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % categories.length
                  : event.key === "ArrowLeft"
                    ? (index + categories.length - 1) % categories.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? categories.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                activate(next);
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {categories.map(([id]) => {
        const active = category === id;
        return (
          <div
            key={id}
            className="sg-content e-focus-inset"
            role="tabpanel"
            id={`settings-panel-${id}`}
            aria-labelledby={`settings-tab-${id}`}
            tabIndex={active ? 0 : -1}
            hidden={!active}
            inert={!active}
            aria-hidden={!active || undefined}
          >
            {active && id === "account" && <AccountSettings />}
            {/* Usage stays mounted after the first visit so returning keeps its rows. */}
            {id === "usage" && usageVisited && <RecordedUsageSection active={active} />}
          </div>
        );
      })}
    </div>
  );
}

function AccountSettings() {
  return (
    <>
      <AccountProfileEditor />
      <PlanCreditsCard />
      <SessionSection />
      <AccountDataControls />
    </>
  );
}

/** Sign out (or Sign in) on this device, with the unsaved-edits confirmation from `useSignOutFlow`. A failed
 * sign-out stays here as "Retry sign-out". The account check has no visible control here: when it fails, the
 * Profile section says so with a labelled "Try again". The hidden check button keeps the explicit check
 * reachable for the recorded-usage browser test, as before. */
function SessionSection() {
  const { session, refresh, signingIn, signingUp, signingOut, signOutError } = useAccountSession();
  const { start, dialog } = useSignOutFlow();
  const signedIn =
    session.status === "ready" || session.status === "checking" || Boolean(signingOut) || Boolean(signOutError);
  const signOutAvailable = session.status === "ready" || signingOut || Boolean(signOutError);
  return (
    <section className="e-section sg-session" aria-label={signedIn ? "Sign out" : "Sign in"}>
      <h2 className="e-section__title">{signedIn ? "Sign out" : "Sign in"}</h2>
      <div className="e-setting-row">
        <p className="e-setting-row__text">
          {signedIn
            ? "Sign out of Embel on this device. Your work stays saved in your account."
            : "Sign in to save your work and settings to your account."}
        </p>
        {signingIn ? (
          <Button variant="secondary" disabled>
            {signingUp ? "Creating account…" : "Signing in…"}
          </Button>
        ) : signOutAvailable ? (
          <Button icon="log-out" variant="secondary" onClick={() => void start()} disabled={signingOut}>
            {signingOut ? "Signing out…" : signOutError ? "Retry sign-out" : "Sign out"}
          </Button>
        ) : session.status === "checking" ? (
          <span className="e-muted" role="status">
            Checking account…
          </span>
        ) : (
          <ButtonLink
            variant="secondary"
            href="/sign-in"
            onClick={(event) => {
              if (!preparePromptForSignIn()) event.preventDefault();
            }}
          >
            Sign in
          </ButtonLink>
        )}
        <button
          type="button"
          className="account-check"
          hidden
          onClick={refresh}
          disabled={session.status === "checking" || signingIn || signingOut}
        >
          Check account
        </button>
        {dialog}
      </div>
    </section>
  );
}
