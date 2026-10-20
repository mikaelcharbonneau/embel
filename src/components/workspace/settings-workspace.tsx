"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { SettingsArtwork, type SettingsArtworkName } from "@/components/ui/settings-artwork";
import { AccountStatus, useAccountSession } from "./account-session";
import { AccountAccess } from "./account-access";
import { LocalChatGPTSettings } from "./local-chatgpt-settings";
import { StrategyRuntimeSettings } from "./strategy-runtime-settings";
import { RecordedUsageSection } from "./recorded-usage";
import { AccountProfileEditor } from "./account-profile-editor";

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
function UnavailableAction({ children, danger = false }: { children: string; danger?: boolean }) {
  return <button type="button" className={`sg-action ${danger ? "sg-danger" : ""}`} disabled title="This action is not available in Embel yet.">{children}</button>;
}
function UnavailableSelect({ label, value = "Unavailable" }: { label: string; value?: string }) {
  return <div className="sg-select-wrap"><select aria-label={label} disabled value={value}><option>{value}</option></select><SettingsArtwork name="chevron-down" /></div>;
}
function UnavailableSwitch({ label }: { label: string }) {
  // An unavailable preference has no verified on/off value.
  return <span className="sg-switch"><button type="button" disabled aria-label={`${label}: unavailable`}><SettingsArtwork name="switch-off" /></button><span>Unavailable</span></span>;
}
function Field({ label, value = "Unavailable" }: { label: string; value?: string }) {
  return <label className="sg-field"><span>{label}</span><input disabled value={value} readOnly /></label>;
}
function SaveFooter({ scope = "account" }: { scope?: "account" | "workspace" }) {
  return <footer className="sg-save"><p>{scope === "account" ? "Account" : "Workspace"} preference editing is not available yet.</p><div><UnavailableAction>Cancel</UnavailableAction><button className="sg-action sg-primary" type="button" disabled>Save changes</button></div></footer>;
}

export function SettingsWorkspace({ localRuntimeEnabled = false }: { localRuntimeEnabled?: boolean }) {
  const [category, setCategory] = useState<Category>("account");
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function activate(index: number) { setCategory(categories[index]![0]); tabs.current[index]?.focus(); }
  return <div className="page settings-guided" data-category={category}>
    <div className="sg-heading"><h1>Settings<span>.</span></h1><p>Manage your account, workspace, and how Embel works for you.</p></div>
    <div className="sg-tabs" role="tablist" aria-label="Settings categories">{categories.map(([id, label], index) =>
      <button key={id} ref={node => { tabs.current[index] = node; }} type="button" role="tab" id={`settings-tab-${id}`} aria-controls={`settings-panel-${id}`} aria-selected={category === id} tabIndex={category === id ? 0 : -1} onClick={() => setCategory(id)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % categories.length : event.key === "ArrowLeft" ? (index + categories.length - 1) % categories.length : event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : null;
        if (next !== null) { event.preventDefault(); activate(next); }
      }}>{label}</button>)}</div>
    <div className="sg-content" role="tabpanel" id={`settings-panel-${category}`} aria-labelledby={`settings-tab-${category}`} tabIndex={0}>
      {category === "account" && <AccountSettings />}
      {category === "workspace" && <WorkspaceSettings />}
      {category === "ai" && <AISettings localRuntimeEnabled={localRuntimeEnabled} />}
      {category === "billing" && <BillingSettings />}
      {category === "notifications" && <NotificationSettings />}
      {category === "security" && <SecuritySettings />}
      {category === "integrations" && <IntegrationSettings />}
    </div>
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
    <Card title="Workspace details" description="Your personal space for brand projects."><div className="sg-fields"><Field label="Workspace name" value="My workspace" /><Field label="Workspace handle" /></div></Card>
    <Card title="Members" description="Shared projects and collaboration are coming soon.">
      <div className="sg-member"><span className="sg-avatar"><Icon name="user" size={18} /></span><div><strong>{session.status === "ready" ? "Personal workspace" : "Sign in to save your work"}</strong><p>Team membership is not available yet.</p></div><span className="sg-badge">Personal workspace</span></div>
      <div className="sg-actions sg-align-end"><UnavailableAction>Invite members</UnavailableAction></div>
    </Card>
    <Card title="Sharing defaults" description="Account projects remain private to their owner." className="sg-rows-card">
      <Row title="Default project visibility" description="Public and team sharing are not available."><UnavailableSelect label="Default project visibility" value="Private" /></Row>
      <Row title="Allow guest invitations" description="Guest access is not available yet."><UnavailableSwitch label="Allow guest invitations" /></Row>
      <Row title="Allow public links" description="Public project links are not available yet."><UnavailableSwitch label="Allow public links" /></Row>
    </Card>
    <SaveFooter scope="workspace" />
    <LocalDraftSettings />
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
    <Card title="Generation defaults" description="Account-wide generation preferences are not available yet." className="sg-rows-card">
      <Row title="Default model" description="Existing model selections are managed per operation."><UnavailableSelect label="Default model" value="Managed per operation" /></Row>
      <Row title="Creativity" description="A saved creativity preference is not available."><UnavailableSelect label="Creativity" /></Row>
      <Row title="Response language" description="A saved generation language preference is not available."><UnavailableSelect label="Response language" /></Row>
    </Card>
    <Card title="Brand context and output" description="These preferences do not change existing project generation behavior." className="sg-rows-card">
      <Row title="Use project context" description="An account-wide context preference is not available."><UnavailableSwitch label="Use project context" /></Row>
      <Row title="Remember my preferences" description="Cross-project tone and style preferences are not available."><UnavailableSwitch label="Remember my preferences" /></Row>
      <Row title="Image quality" description="Logo options are managed in each project’s logo workspace."><UnavailableSelect label="Image quality" /></Row>
    </Card>
    <SaveFooter />
    {localRuntimeEnabled ? <LocalChatGPTSettings enabled /> : <Card title="Text and strategy" description="Read-only readiness for your verified account."><StrategyRuntimeSettings /></Card>}
    <Card title="Images" description="Logo concepts and saved-preview refinements have separate readiness checks in each project’s logo workspace. Text readiness does not confirm image access."><Link className="sg-action" href="/brands">Open projects</Link></Card>
  </>;
}

function BillingSettings() {
  return <>
    <div className="sg-summary">
      <Card title="Current plan" description="Embel billing is not connected."><strong className="sg-metric">Unavailable</strong><p className="sg-note">No verified plan, price, or next invoice is available.</p><UnavailableAction>Manage plan</UnavailableAction></Card>
      <Card title="AI credits" description="An account credit balance is not available."><strong className="sg-metric">Unknown</strong><div className="sg-credit-track" aria-hidden="true" /><p className="sg-note">Recorded token usage is shown below; it is not a credit balance.</p><a className="sg-action" href="#recorded-usage-title">View usage</a></Card>
    </div>
    <Card title="Billing details" description="Payment methods and billing preferences are not available." className="sg-rows-card">
      <Row title="Payment method" description="No verified payment details available."><UnavailableAction>Update</UnavailableAction></Row>
      <Row title="Billing email" description="No verified billing email available."><UnavailableAction>Edit</UnavailableAction></Row>
    </Card>
    <Card title="Invoices" description="Invoice history is not connected."><div className="sg-invoices"><table><thead><tr>{["Date", "Description", "Amount", "Status"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody><tr><td colSpan={4}>Invoices unavailable. No verified invoices or downloads are available.</td></tr></tbody></table></div></Card>
    <RecordedUsageSection />
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
    <Card title="Notification preferences" description="Email and in-app preferences are not available yet." className="sg-rows-card">
      <div className="sg-notification-head"><span /><span>Email</span><span>In-app</span></div>
      {notifications.map(([title, description]) => <div className="sg-notification-row" key={title}><div className="sg-row-copy"><strong>{title}</strong><p>{description}</p></div><UnavailableSwitch label={`${title} email`} /><UnavailableSwitch label={`${title} in-app`} /></div>)}
      <p className="sg-note">No opt-in or delivery preference has been set here. Existing job activity remains available in the account menu.</p>
    </Card>
    <SaveFooter />
  </>;
}

function SecuritySettings() {
  return <>
    <Card title="Sign-in and security" description="Keep your account and active sessions under control." className="sg-rows-card">
      <Row title="Password" description="Password management is not available here."><UnavailableAction>Change password</UnavailableAction></Row>
      <Row title="Two-factor authentication" description="Two-factor setup and status are not available here."><UnavailableAction>Set up</UnavailableAction></Row>
      <Row title="Active sessions" description="A list of signed-in devices is not available."><UnavailableAction>Manage sessions</UnavailableAction></Row>
      <Row title="Current session" description="Check your account or sign out of Embel."><AccountAccess /></Row>
    </Card>
    <Card title="Data and privacy" description="Account-wide privacy preference editing is not available yet." className="sg-rows-card">
      <Row title="Save generation history" description="Existing saved outputs are unchanged."><UnavailableSwitch label="Save generation history" /></Row>
      <Row title="Help improve Embel" description="No feedback opt-in is set by this screen."><UnavailableSwitch label="Help improve Embel" /></Row>
      <Row title="History retention" description="No account retention preference is available."><UnavailableSelect label="History retention" /></Row>
      <Row title="Export account data" description="A complete account data export is not available."><UnavailableAction>Export data</UnavailableAction></Row>
    </Card>
    <SaveFooter />
    <section className="sg-delete" aria-label="Delete account"><div><h2>Delete account</h2><p>Account deletion is not available here yet.</p></div><UnavailableAction danger>Delete account</UnavailableAction></section>
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
    <Card title="Connected apps" description="Embel app connections are not available yet." className="sg-rows-card">
      {integrations.map(app => <div className="sg-integration" key={app.name}><span className="sg-integration-icon"><SettingsArtwork name={app.icon} /></span><div className="sg-row-copy"><strong>{app.name}</strong><p>{app.description}</p></div><span className="sg-integration-status">Unavailable</span><UnavailableAction>Connect</UnavailableAction></div>)}
    </Card>
    <Card title="Connection preferences" description="These controls require a supported Embel app connection." className="sg-rows-card">
      <Row title="Ask before exporting" description="No export permission or destination is changed here."><UnavailableSwitch label="Ask before exporting" /></Row>
      <Row title="Sync new exports" description="Automatic app exports are not available."><UnavailableSwitch label="Sync new exports" /></Row>
    </Card>
    <SaveFooter scope="workspace" />
    <Card title="Availability checks" description="Availability checks are separate from connected apps. Each tool shows which checks are currently supported."><p className="sg-note">Sign in and open a tool to review its available checks. A connected app does not confirm availability, and trademark results are not legal clearance.</p><div className="sg-actions"><Link className="sg-action" href="/domains">Open domains</Link><Link className="sg-action" href="/handles">Open handles</Link><Link className="sg-action" href="/trademarks">Open trademarks</Link></div></Card>
  </>;
}
