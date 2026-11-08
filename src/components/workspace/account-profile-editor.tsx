"use client";

import { SettingsArtwork } from "@/components/ui/settings-artwork";
import { DEFAULT_PROFILE_VALUES, PROFILE_TIME_ZONES, formatAccountDate, type AccountProfileValues } from "@/domain/account-profile";
import { useAccountSession } from "./account-session";
import { useAccountProfile } from "./account-profile-provider";
import { profileHasEdits } from "./account-profile-memory";

// Display names only; the saved value stays the time zone identifier.
const timeZoneLabels: Record<AccountProfileValues["timeZone"], string> = {
  "America/Toronto": "Toronto — Eastern Time",
  "America/Vancouver": "Vancouver — Pacific Time",
  "America/New_York": "New York — Eastern Time",
  "America/Chicago": "Chicago — Central Time",
  "America/Denver": "Denver — Mountain Time",
  "America/Los_Angeles": "Los Angeles — Pacific Time",
  "America/Sao_Paulo": "São Paulo — Brasília Time",
  "Europe/London": "London — UK Time",
  "Europe/Paris": "Paris — Central European Time",
  "Europe/Berlin": "Berlin — Central European Time",
  "Africa/Johannesburg": "Johannesburg — South Africa Time",
  "Asia/Dubai": "Dubai — Gulf Time",
  "Asia/Kolkata": "Kolkata — India Time",
  "Asia/Singapore": "Singapore — Singapore Time",
  "Asia/Tokyo": "Tokyo — Japan Time",
  "Australia/Sydney": "Sydney — Eastern Australia Time",
  "Pacific/Auckland": "Auckland — New Zealand Time",
  "UTC": "UTC — Coordinated Universal Time",
};

export function AccountProfileEditor() {
  const { session } = useAccountSession();
  const profile = useAccountProfile();
  const workspace = profile?.workspace ?? null;
  const ready = session.status === "ready" && workspace !== null;
  const values = workspace?.values ?? DEFAULT_PROFILE_VALUES;
  const locked = !ready || profile!.busy || workspace!.mustReload || workspace!.latest !== null;
  const dirty = workspace !== null && profileHasEdits(workspace);
  const update = (patch: Partial<AccountProfileValues>) => profile?.edit({ ...values, ...patch });
  const unavailable = session.status === "ready" ? "Loading…" : "Unavailable";
  return <>
    <section className="sg-card" aria-label="Profile"><header><h2>Profile</h2><p>Your name appears in the account menu.</p></header><div className="sg-card-body">
      <div className="sg-fields"><label className="sg-field"><span>Full name</span><input autoComplete="name" maxLength={100} disabled={locked} value={ready ? values.fullName : unavailable} onChange={event => update({ fullName: event.target.value })} /></label>
        <label className="sg-field"><span>Email address</span><input type="text" autoComplete="email" readOnly disabled={!ready} value={ready ? workspace.saved.email ?? "No account email" : unavailable} aria-describedby="profile-email-note" /></label></div>
      <p id="profile-email-note" className="sg-note sg-profile-note">You sign in with this email.</p>
    </div></section>
    <section className="sg-card sg-rows-card" aria-label="Preferences"><header><h2>Preferences</h2><p>Choose how dates appear in Embel.</p></header><div className="sg-card-body">
      <div className="sg-row"><div className="sg-row-copy"><strong>Time zone</strong><p>Used for the dates and times Embel shows you.</p></div><div className="sg-select-wrap"><select aria-label="Time zone" disabled={locked} value={values.timeZone} onChange={event => update({ timeZone: event.target.value as AccountProfileValues["timeZone"] })}>{PROFILE_TIME_ZONES.map(zone => <option key={zone} value={zone}>{timeZoneLabels[zone]}</option>)}</select><SettingsArtwork name="chevron-down" /></div></div>
      <div className="sg-row"><div className="sg-row-copy"><strong>Date format</strong><p>Preview: <output aria-label="Date format preview">{formatAccountDate("2026-10-13T00:30:00Z", values)}</output></p></div><div className="sg-select-wrap"><select aria-label="Date format" disabled={locked} value={values.dateFormat} onChange={event => update({ dateFormat: event.target.value as AccountProfileValues["dateFormat"] })}><option value="friendly">Month, day, year</option><option value="iso">YYYY-MM-DD</option></select><SettingsArtwork name="chevron-down" /></div></div>
    </div></section>
    {workspace?.latest && <section className="sg-card sg-profile-conflict" aria-label="Settings changed in another session"><header><h2>Review the saved settings</h2><p>Your edits are kept. Choose the saved version, or keep your edits and save again.</p></header><div className="sg-card-body"><dl><div><dt>Saved full name</dt><dd>{workspace.latest.values.fullName || "No name set"}</dd></div><div><dt>Saved time zone</dt><dd>{timeZoneLabels[workspace.latest.values.timeZone]}</dd></div><div><dt>Saved date format</dt><dd>{workspace.latest.values.dateFormat === "iso" ? "YYYY-MM-DD" : "Month, day, year"}</dd></div></dl><div className="sg-actions"><button type="button" className="button secondary small" disabled={profile!.busy} onClick={profile!.discard}>Use saved settings</button><button type="button" className="button secondary small" disabled={profile!.busy} onClick={profile!.keepEdits}>Keep my edits</button></div></div></section>}
    {/* The status line stays mounted so save results are announced; Saved text comes only from the confirmed revision. */}
    <footer className="sg-save"><p role="status">{profile?.notice ?? (profile?.busy ? "Checking your account settings…" : dirty ? "You have unsaved changes." : ready ? workspace.saved.revision === 0 ? "" : "Your settings are saved." : "Sign in to edit your profile and preferences.")}</p><div><button type="button" className="button secondary small" disabled={locked || !dirty} onClick={profile?.discard}>Cancel</button><button type="button" className="button primary small" disabled={locked || !dirty} onClick={profile?.save}>Save changes</button></div></footer>
    {profile?.error && <div className="sg-profile-feedback" role="alert"><p>{profile.error}</p></div>}
    {session.status === "ready" && !profile?.busy && (profile?.error || workspace?.mustReload || !workspace) && <div className="sg-actions"><button type="button" className="button secondary small" onClick={profile?.reload}>Check saved settings</button></div>}
  </>;
}
