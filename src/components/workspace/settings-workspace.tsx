"use client";

import { useRef, useState } from "react";
import { useAccountSession } from "./account-session";
import { AccountAccess } from "./account-access";
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

/** Sign out (or Sign in) on this device. The controls and the unsaved-edits confirmation come from AccountAccess;
 * this section gives them the Settings layout. AccountAccess's round "Check account" button is hidden here: when the
 * account check fails, the Profile section says so with a labelled "Try again". */
function SessionSection() {
  const { session, signingOut, signOutError } = useAccountSession();
  const signedIn =
    session.status === "ready" || session.status === "checking" || Boolean(signingOut) || Boolean(signOutError);
  return (
    <section className="e-section sg-session" aria-label={signedIn ? "Sign out" : "Sign in"}>
      <h2 className="e-section__title">{signedIn ? "Sign out" : "Sign in"}</h2>
      <div className="e-setting-row">
        <p className="e-setting-row__text">
          {signedIn
            ? "Sign out of Embel on this device. Your work stays saved in your account."
            : "Sign in to save your work and settings to your account."}
        </p>
        <AccountAccess />
      </div>
    </section>
  );
}
