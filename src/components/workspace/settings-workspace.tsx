"use client";

import { useRef, useState } from "react";
import { useAccountSession } from "./account-session";
import { AccountAccess } from "./account-access";
import { RecordedUsageSection } from "./recorded-usage";
import { AccountProfileEditor } from "./account-profile-editor";
import { AccountDataControls } from "./account-data-controls";

// Settings always opens on Account, so links to removed categories
// (for example ?category=security) land there.
const categories = [["account", "Account"], ["usage", "Usage"]] as const;
type Category = typeof categories[number][0];

export function SettingsWorkspace() {
  const [category, setCategory] = useState<Category>("account");
  const [usageVisited, setUsageVisited] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function selectCategory(next: Category) {
    if (next === "usage") setUsageVisited(true);
    setCategory(next);
  }
  function activate(index: number) { selectCategory(categories[index]![0]); tabs.current[index]?.focus(); }
  return <div className="page settings-guided" data-category={category}>
    <div className="sg-heading"><h1>Settings<span>.</span></h1><p>Manage your account and see your usage.</p></div>
    <div className="sg-tabs" role="tablist" aria-label="Settings">{categories.map(([id, label], index) =>
      <button key={id} ref={node => { tabs.current[index] = node; }} type="button" role="tab" id={`settings-tab-${id}`} aria-controls={`settings-panel-${id}`} aria-selected={category === id} tabIndex={category === id ? 0 : -1} onClick={() => selectCategory(id)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % categories.length : event.key === "ArrowLeft" ? (index + categories.length - 1) % categories.length : event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : null;
        if (next !== null) { event.preventDefault(); activate(next); }
      }}>{label}</button>)}</div>
    {categories.map(([id]) => {
      const active = category === id;
      return <div key={id} className="sg-content" role="tabpanel" id={`settings-panel-${id}`} aria-labelledby={`settings-tab-${id}`} tabIndex={active ? 0 : -1} hidden={!active} inert={!active} aria-hidden={!active || undefined}>
        {active && id === "account" && <AccountSettings />}
        {/* Usage stays mounted after the first visit so returning keeps its rows. */}
        {id === "usage" && usageVisited && <RecordedUsageSection active={active} />}
      </div>;
    })}
  </div>;
}

function AccountSettings() {
  const { session } = useAccountSession();
  const signedIn = session.status === "ready";
  return <>
    <AccountProfileEditor />
    <section className="sg-card sg-session" aria-label={signedIn ? "Sign out" : "Sign in"}>
      <div className="sg-row"><div className="sg-row-copy"><strong>{signedIn ? "Sign out" : "Sign in"}</strong><p>{signedIn ? "Sign out of Embel on this device. Your work stays saved in your account." : "Sign in to save your work and settings to your account."}</p></div><AccountAccess /></div>
    </section>
    <AccountDataControls />
    {/* Only on a local development server; hosted Embel never renders it. */}
  </>;
}
