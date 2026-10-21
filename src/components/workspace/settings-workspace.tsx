"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import type { SettingsArtworkName } from "@/components/ui/settings-artwork";
import { AccountStatus, useAccountSession } from "./account-session";
import { AccountAccess } from "./account-access";
import { LocalChatGPTSettings } from "./local-chatgpt-settings";
import { StrategyRuntimeSettings } from "./strategy-runtime-settings";
import { RecordedUsageSection } from "./recorded-usage";
import { AccountProfileEditor } from "./account-profile-editor";
import { SettingsAvailability } from "./settings-availability";

const categories = [
  ["account", "Account"], ["workspace", "Workspace"], ["ai", "AI preferences"],
  ["billing", "Usage & billing"], ["notifications", "Notifications"],
  ["security", "Security & privacy"], ["integrations", "Integrations"],
] as const;
type Category = typeof categories[number][0];

function Card({ title, description, children, className = "" }: { title: string; description: string; children: ReactNode; className?: string }) {
  return <section className={`sg-card ${className}`} aria-label={title}><header><h2>{title}</h2><p>{description}</p></header><div className="sg-card-body">{children}</div></section>;
}
function Row({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="sg-row"><div className="sg-row-copy"><strong>{title}</strong><p>{description}</p></div>{children}</div>;
}

export function SettingsWorkspace({ localRuntimeEnabled = false }: { localRuntimeEnabled?: boolean }) {
  const [category, setCategory] = useState<Category>("account");
  const [usageVisited, setUsageVisited] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function selectCategory(next: Category) {
    if (next === "billing") setUsageVisited(true);
    setCategory(next);
  }
  function activate(index: number) { selectCategory(categories[index]![0]); tabs.current[index]?.focus(); }
  return <div className="page settings-guided" data-category={category}>
    <div className="sg-heading"><div><h1>Settings<span>.</span></h1><p>Manage your account, workspace, and how Embel works for you.</p></div><button type="button" className="sg-action" onClick={() => activate(categories.findIndex(([id]) => id === "billing"))}>View recorded usage</button></div>
    <div className="sg-tabs" role="tablist" aria-label="Settings categories">{categories.map(([id, label], index) =>
      <button key={id} ref={node => { tabs.current[index] = node; }} type="button" role="tab" id={`settings-tab-${id}`} aria-controls={`settings-panel-${id}`} aria-selected={category === id} tabIndex={category === id ? 0 : -1} onClick={() => selectCategory(id)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % categories.length : event.key === "ArrowLeft" ? (index + categories.length - 1) % categories.length : event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : null;
        if (next !== null) { event.preventDefault(); activate(next); }
      }}>{label}</button>)}</div>
    {categories.map(([id]) => {
      const active = category === id;
      return <div key={id} className="sg-content" role="tabpanel" id={`settings-panel-${id}`} aria-labelledby={`settings-tab-${id}`} tabIndex={active ? 0 : -1} hidden={!active} inert={!active} aria-hidden={!active || undefined}>
        {active && id === "account" && <AccountSettings />}
        {active && id === "workspace" && <WorkspaceSettings />}
        {active && id === "ai" && <AISettings localRuntimeEnabled={localRuntimeEnabled} />}
        {id === "billing" && usageVisited && <BillingSettings active={active} />}
        {active && id === "notifications" && <NotificationSettings />}
        {active && id === "security" && <SecuritySettings />}
        {active && id === "integrations" && <IntegrationSettings />}
      </div>;
    })}
  </div>;
}

function AccountSettings() {
  const { session } = useAccountSession();
  return <>
    <AccountProfileEditor />
    <Card title="Account connection" description="Your current Embel sign-in status.">{session.status === "ready" ? <p className="sg-note">A verified account session is connected. <Link className="text-link" href="/brands">Open projects</Link> to view saved account projects.</p> : <AccountStatus />}</Card>
  </>;
}

function WorkspaceSettings() {
  const { session } = useAccountSession();
  return <>
    <Card title="Your workspace" description="A personal space for your brand projects.">
      <div className="sg-member"><span className="sg-avatar"><Icon name="user" size={18} /></span><div><strong>My workspace</strong><p>{session.status === "ready" ? "Account projects are private to their owner." : "Sign in to save your projects to your account."}</p></div><span className="sg-badge">Personal workspace</span></div>
    </Card>
    <LocalDraftSettings />
    <SettingsAvailability title="Workspace options" description="Workspace editing and collaboration are not available. Your account projects remain private." items={[
      { title: "Workspace name and handle", description: "Custom workspace names and handles cannot be edited here." },
      { title: "Members and invitations", description: "Team membership and guest invitations are not available." },
      { title: "Project sharing", description: "Default visibility cannot be changed. Public links and team sharing are not available." },
    ]} />
  </>;
}

function LocalDraftSettings() {
  const { session } = useAccountSession();
  return <Card title="Recover unsaved work" description="Your work saves automatically to your account. Recover drafts left by an earlier version of Embel here.">
    {session.status === "ready" ? <div className="sg-actions"><Link className="sg-action" href="/brands?recover=1">Recover projects</Link><Link className="sg-action" href="/names?recover=1">Recover names</Link></div> : <AccountStatus />}
  </Card>;
}

function AISettings({ localRuntimeEnabled }: { localRuntimeEnabled: boolean }) {
  return <>
    {localRuntimeEnabled ? <LocalChatGPTSettings enabled /> : <Card title="Text and strategy" description="Read-only readiness for your verified account."><StrategyRuntimeSettings /></Card>}
    <Card title="Images" description="Logo concepts and saved-preview refinements have separate readiness checks in each project’s logo workspace. Text readiness does not confirm image access."><Link className="sg-action" href="/brands">Open projects</Link></Card>
    <SettingsAvailability title="Generation preferences" description="Account-wide defaults are not available. Existing operation settings and project choices remain unchanged." items={[
      { title: "Default model", description: "Existing model selections are managed per operation." },
      { title: "Creativity and response language", description: "Account-wide creativity and generation language preferences are not available." },
      { title: "Project context and remembered preferences", description: "Account-wide context, tone and style preferences are not available." },
      { title: "Image quality", description: "Logo options are managed in each project’s logo workspace." },
    ]} />
  </>;
}

function BillingSettings({ active }: { active: boolean }) {
  return <>
    <RecordedUsageSection active={active} />
    <SettingsAvailability title="Billing services" description="Billing is not connected. Recorded token history is separate from a plan, credit balance or invoice." items={[
      { title: "Current plan", description: "No verified plan, price or next invoice is available. Plan management is not connected." },
      { title: "AI credits", description: "The account credit balance is unknown. Recorded usage is not a credit balance." },
      { title: "Payment method and billing email", description: "No verified payment details or billing email are available to edit here." },
      { title: "Invoices", description: "Invoice history and invoice downloads are not connected." },
    ]} />
  </>;
}

const notifications = [
  ["Generation completed", "When a requested generation finishes."], ["Mentions and comments", "When someone mentions you or comments on a project."],
  ["Workspace invitations", "Invitations to join a shared workspace."], ["Usage alerts", "Updates about usage and limits."],
  ["Billing updates", "Payment and invoice updates."], ["Product updates", "New features and improvements to Embel."],
  ["Tips and inspiration", "Guides and ideas to help you build your brand."],
] as const;
function NotificationSettings() {
  return <>
    <Card title="Generation activity" description="Review existing job activity in the account menu.">
      <p className="sg-note">Email and in-app notification preferences are not available. No opt-in or delivery preference is set by this screen.</p>
    </Card>
    <SettingsAvailability title="Notification preferences" description="Notification delivery preferences cannot be changed here." items={notifications.map(([title, description]) => ({ title, description: `${description} Email and in-app preferences are not available.` }))} />
  </>;
}

function SecuritySettings() {
  return <>
    <Card title="Sign-in and security" description="Your current Embel sign-in." className="sg-rows-card">
      <Row title="Current session" description="Check your account or sign out of Embel."><AccountAccess /></Row>
    </Card>
    <SettingsAvailability title="Security and privacy options" description="Additional account controls are not available here. Existing saved outputs and privacy choices are unchanged." items={[
      { title: "Password and two-factor authentication", description: "Password management, two-factor setup and verified two-factor status are not available here." },
      { title: "Active sessions", description: "A list of signed-in devices and session management are not available." },
      { title: "Generation history and retention", description: "Account-wide history saving and retention preferences are not available." },
      { title: "Help improve Embel", description: "No feedback opt-in is set by this screen." },
      { title: "Export account data", description: "A complete account data export is not available." },
      { title: "Delete account", description: "Account deletion is not available here." },
    ]} />
  </>;
}

const integrations: { name: string; icon: SettingsArtworkName; description: string }[] = [
  { name: "Figma", icon: "figma", description: "Import designs and export assets to your files." },
  { name: "Google Drive", icon: "googledrive", description: "Bring brand documents and reference files into Embel." },
  { name: "Notion", icon: "notion", description: "Use briefs and notes from your Notion workspace." },
  { name: "Slack", icon: "slack", description: "Share project updates with your team." },
];
function IntegrationSettings() {
  return <>
    <Card title="Availability checks" description="Availability checks are separate from connected apps. Each tool shows which checks are currently supported."><p className="sg-note">Sign in and open a tool to review its available checks. A connected app does not confirm availability, and trademark results are not legal clearance.</p><div className="sg-actions"><Link className="sg-action" href="/domains">Open domains</Link><Link className="sg-action" href="/handles">Open handles</Link><Link className="sg-action" href="/trademarks">Open trademarks</Link></div></Card>
    <SettingsAvailability title="Connected apps" description="Embel app connections and automatic exports are not available. No export permission or destination is changed here." items={[
      ...integrations.map(app => ({ title: app.name, icon: app.icon, description: `${app.description} This connection is not available.` })),
      { title: "Connection preferences", description: "Ask before exporting and automatic syncing require a supported connection and are not available." },
    ]} />
  </>;
}
