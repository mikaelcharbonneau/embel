"use client";

import { Icon } from "@/components/ui/icon";
import { SettingsArtwork } from "@/components/ui/settings-artwork";
import { DEFAULT_PROFILE_VALUES, PROFILE_TIME_ZONES, formatAccountDate, type AccountProfileValues } from "@/domain/account-profile";
import { useAccountSession } from "./account-session";
import { useAccountProfile } from "./account-profile-provider";
import { profileHasEdits } from "./account-profile-memory";

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
    <section className="sg-card" aria-label="Profile"><header><h2>Profile</h2><p>Your name is saved to your account and shown in the account menu.</p></header><div className="sg-card-body">
      <div className="sg-photo"><span className="sg-avatar"><Icon name="user" size={24} /></span><div><div className="sg-actions"><button type="button" className="sg-action" disabled>Upload photo</button><button type="button" className="sg-action" disabled>Remove</button></div><p>Profile photos are not available yet.</p></div></div>
      <div className="sg-fields"><label className="sg-field"><span>Full name</span><input autoComplete="name" maxLength={100} disabled={locked} value={ready ? values.fullName : unavailable} onChange={event => update({ fullName: event.target.value })} /></label>
        <label className="sg-field"><span>Email address</span><input type="text" autoComplete="email" readOnly disabled={!ready} value={ready ? workspace.saved.email ?? "No account email" : unavailable} aria-describedby="profile-email-note" /></label></div>
      <p id="profile-email-note" className="sg-note sg-profile-note">Your email comes from your verified sign-in. Email changes are not available here.</p>
    </div></section>
    <section className="sg-card sg-rows-card" aria-label="Preferences"><header><h2>Preferences</h2><p>Saved date settings apply to Activity, usage history, and research-source dates.</p></header><div className="sg-card-body">
      <div className="sg-row"><div className="sg-row-copy"><strong>Language</strong><p>Menus and controls currently use English.</p></div><div className="sg-select-wrap"><select aria-label="Language" disabled value="English"><option>English</option></select><SettingsArtwork name="chevron-down" /></div></div>
      <div className="sg-row"><div className="sg-row-copy"><strong>Time zone</strong><p>Choose the time zone used for these saved activity dates.</p></div><div className="sg-select-wrap"><select aria-label="Time zone" disabled={locked} value={values.timeZone} onChange={event => update({ timeZone: event.target.value as AccountProfileValues["timeZone"] })}>{PROFILE_TIME_ZONES.map(zone => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}</select><SettingsArtwork name="chevron-down" /></div></div>
      <div className="sg-row"><div className="sg-row-copy"><strong>Date format</strong><p>Preview: <output aria-label="Date format preview">{formatAccountDate("2026-10-13T00:30:00Z", values)}</output></p></div><div className="sg-select-wrap"><select aria-label="Date format" disabled={locked} value={values.dateFormat} onChange={event => update({ dateFormat: event.target.value as AccountProfileValues["dateFormat"] })}><option value="friendly">Month, day, year</option><option value="iso">YYYY-MM-DD</option></select><SettingsArtwork name="chevron-down" /></div></div>
      <div className="sg-row"><div className="sg-row-copy"><strong>Appearance</strong><p>Fluid currently uses its light appearance.</p></div><div className="sg-select-wrap"><select aria-label="Appearance" disabled value="Light"><option>Light</option></select><SettingsArtwork name="chevron-down" /></div></div>
    </div></section>
    {workspace?.latest && <section className="sg-card sg-profile-conflict" aria-label="Settings changed in another session"><header><h2>Review the saved settings</h2><p>Your edits are kept. Choose the saved version, or keep your edits and save again.</p></header><div className="sg-card-body"><dl><div><dt>Saved full name</dt><dd>{workspace.latest.values.fullName || "No name set"}</dd></div><div><dt>Saved time zone</dt><dd>{workspace.latest.values.timeZone}</dd></div><div><dt>Saved date format</dt><dd>{workspace.latest.values.dateFormat === "iso" ? "YYYY-MM-DD" : "Month, day, year"}</dd></div></dl><div className="sg-actions"><button type="button" className="sg-action" disabled={profile!.busy} onClick={profile!.discard}>Use saved settings</button><button type="button" className="sg-action" disabled={profile!.busy} onClick={profile!.keepEdits}>Keep my edits</button></div></div></section>}
    <footer className="sg-save"><p role="status">{profile?.notice ?? (profile?.busy ? "Checking your account settings…" : dirty ? "You have unsaved changes." : ready ? workspace.saved.revision === 0 ? "Choose your preferences, then save them to your account." : "Your saved settings are up to date." : "Sign in to edit your profile and save preferences.")}</p><div><button type="button" className="sg-action" disabled={locked || !dirty} onClick={profile?.discard}>Cancel</button><button type="button" className="sg-action sg-primary" disabled={locked || !dirty} onClick={profile?.save}>Save changes</button></div></footer>
    {profile?.error && <div className="sg-profile-feedback" role="alert"><p>{profile.error}</p></div>}
    {session.status === "ready" && !profile?.busy && (profile?.error || workspace?.mustReload || !workspace) && <div className="sg-actions"><button type="button" className="sg-action" onClick={profile?.reload}>Check saved settings</button></div>}
  </>;
}
