"use client";

import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { PROFILE_TIME_ZONES, formatAccountDate, type AccountProfileValues } from "@/domain/account-profile";
import { useAccountSession } from "./account-session";
import { PROFILE_SAVE_FAILED, useAccountProfile } from "./account-profile-provider";
import { profileHasEdits } from "./account-profile-memory";
import { Button, Spinner } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { InlineMessage } from "@/components/ui/message";
import { LoadingRegion, Skeleton } from "@/components/ui/feedback";

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
  UTC: "UTC — Coordinated Universal Time",
};
const DATE_FORMATS: AccountProfileValues["dateFormat"][] = ["friendly", "iso"];
/** A date format is named by an example date, in the chosen time zone. */
const dateFormatLabel = (dateFormat: AccountProfileValues["dateFormat"], timeZone: AccountProfileValues["timeZone"]) =>
  formatAccountDate("2026-10-13T00:30:00Z", { dateFormat, timeZone });

type Field = keyof AccountProfileValues;
type SaveState = "idle" | "saving" | "saved" | "failed";
// Typing waits for a pause; a chosen option saves at once.
const AUTOSAVE_DELAY: Record<Field, number> = { fullName: 650, timeZone: 0, dateFormat: 0 };

/** Settings → Account: profile and date preferences. Each change saves on its own; "Saved" appears only after the
 * server confirms, and a failed save offers one "Try again". */
export function AccountProfileEditor() {
  const { session, refresh } = useAccountSession();
  const profile = useAccountProfile();
  const [field, setField] = useState<Field>("fullName");
  const workspace = profile?.workspace ?? null;

  if (session.status === "checking" || (session.status === "ready" && !workspace && !profile?.error))
    return <LoadingProfile />;
  if (session.status !== "ready")
    return (
      <ProfileSection>
        {session.status === "signed_out" ? (
          <p className="e-muted" role="status">
            Sign in to edit your profile and preferences.
          </p>
        ) : (
          <InlineMessage
            tone="danger"
            actions={
              <Button size="sm" icon="rotate-ccw" onClick={refresh}>
                Try again
              </Button>
            }
          >
            Your account couldn’t be checked. Check your connection, then try again.
          </InlineMessage>
        )}
      </ProfileSection>
    );
  if (!profile || !workspace)
    return (
      <ProfileSection>
        <InlineMessage
          tone="danger"
          actions={
            <Button size="sm" icon="rotate-ccw" onClick={profile?.reload}>
              Try again
            </Button>
          }
        >
          {profile?.error}
        </InlineMessage>
      </ProfileSection>
    );

  const values = workspace.values;
  const dirty = profileHasEdits(workspace);
  // Reading locks the fields; a running save does not, so typing never loses focus.
  const locked = (profile.busy && !profile.saving) || workspace.latest !== null;
  const retrying = profile.busy && !profile.saving && workspace.mustReload;
  const state: SaveState = profile.error
    ? "failed"
    : profile.saving || retrying
      ? "saving"
      : profile.confirmed && !dirty
        ? "saved"
        : "idle";
  // After an interrupted save the message is always about saving, whichever step failed.
  const failure = workspace.mustReload ? PROFILE_SAVE_FAILED : profile.error;
  const status = (owner: Field) => (
    <SaveStatus
      id={`profile-${owner}-status`}
      state={field === owner ? state : "idle"}
      error={failure}
      onRetry={workspace.mustReload ? profile.reload : undefined}
    />
  );
  function update(next: Field, patch: Partial<AccountProfileValues>) {
    setField(next);
    profile!.edit({ ...values, ...patch });
  }

  return (
    <>
      <ProfileAutosave delay={AUTOSAVE_DELAY[field]} />
      <ProfileSection>
        {workspace.latest && (
          <InlineMessage
            tone="warning"
            title="Your settings changed in another session"
            actions={
              <>
                <Button size="sm" disabled={profile.busy} onClick={profile.discard}>
                  Use saved settings
                </Button>
                <Button size="sm" disabled={profile.busy} onClick={profile.keepEdits}>
                  Keep my edits
                </Button>
              </>
            }
          >
            <p>Your edits are kept. Use the saved settings, or keep your edits and save them.</p>
            <dl className="sg-saved-values">
              <div>
                <dt>Saved full name</dt>
                <dd>{workspace.latest.values.fullName || "No name set"}</dd>
              </div>
              <div>
                <dt>Saved time zone</dt>
                <dd>{timeZoneLabels[workspace.latest.values.timeZone]}</dd>
              </div>
              <div>
                <dt>Saved date format</dt>
                <dd>{dateFormatLabel(workspace.latest.values.dateFormat, workspace.latest.values.timeZone)}</dd>
              </div>
            </dl>
          </InlineMessage>
        )}
        <div className="e-grid-fields">
          <div className="e-field">
            <label className="e-field__label" htmlFor="profile-full-name">
              Full name
            </label>
            <div className="e-input">
              <input
                id="profile-full-name"
                autoComplete="name"
                maxLength={100}
                disabled={locked}
                value={values.fullName}
                aria-describedby="profile-fullName-status"
                onChange={(event) => update("fullName", { fullName: event.target.value })}
              />
            </div>
            {status("fullName")}
          </div>
          <div className="e-field">
            <label className="e-field__label" htmlFor="profile-email">
              Email address
            </label>
            <div className="e-input">
              <input
                id="profile-email"
                type="text"
                autoComplete="email"
                readOnly
                value={workspace.saved.email ?? "No account email"}
              />
            </div>
          </div>
        </div>
      </ProfileSection>
      <PreferencesSection>
        <PreferenceRow title="Time zone" status={status("timeZone")}>
          <select
            aria-label="Time zone"
            aria-describedby="profile-timeZone-status"
            disabled={locked}
            value={values.timeZone}
            onChange={(event) =>
              update("timeZone", { timeZone: event.target.value as AccountProfileValues["timeZone"] })
            }
          >
            {PROFILE_TIME_ZONES.map((zone) => (
              <option key={zone} value={zone}>
                {timeZoneLabels[zone]}
              </option>
            ))}
          </select>
        </PreferenceRow>
        <PreferenceRow title="Date format" status={status("dateFormat")}>
          <select
            aria-label="Date format"
            aria-describedby="profile-dateFormat-status"
            disabled={locked}
            value={values.dateFormat}
            onChange={(event) =>
              update("dateFormat", { dateFormat: event.target.value as AccountProfileValues["dateFormat"] })
            }
          >
            {DATE_FORMATS.map((format) => (
              <option key={format} value={format}>
                {dateFormatLabel(format, values.timeZone)}
              </option>
            ))}
          </select>
        </PreferenceRow>
      </PreferencesSection>
    </>
  );
}

/** Saves the edits in memory after a pause, unless a read, a save, a failure or a conflict is in the way. */
function ProfileAutosave({ delay }: { delay: number }) {
  const profile = useAccountProfile();
  const workspace = profile?.workspace ?? null;
  const save = useEffectEvent(() => profile?.save());
  const blocked =
    !workspace ||
    Boolean(profile?.busy || profile?.error) ||
    workspace.mustReload ||
    workspace.latest !== null ||
    !profileHasEdits(workspace);
  useEffect(() => {
    if (blocked) return;
    const timer = setTimeout(save, delay);
    return () => clearTimeout(timer);
  }, [workspace, blocked, delay]);
  return null;
}

/** The line under a field: "Saving", "Saved" (only after the server confirms) or the failure with one "Try again".
 * The polite region stays mounted so each change is announced. */
function SaveStatus({
  id,
  state,
  error,
  onRetry,
}: {
  id: string;
  state: SaveState;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <div id={id} className="sg-status" aria-live="polite" data-state={state}>
      {state === "saving" ? (
        <p className="sg-status__line">
          <Spinner />
          Saving
        </p>
      ) : state === "saved" ? (
        <p className="sg-status__line sg-status__line--saved">
          <Icon name="check" size="sm" />
          Saved
        </p>
      ) : state === "failed" ? (
        <>
          <InlineMessage tone="danger" form="field">
            {error}
          </InlineMessage>
          {onRetry && (
            <Button size="sm" icon="rotate-ccw" onClick={onRetry}>
              Try again
            </Button>
          )}
        </>
      ) : null}
    </div>
  );
}

function ProfileSection({ children }: { children: ReactNode }) {
  return (
    <section className="e-section" aria-labelledby="profile-title">
      <h2 className="e-section__title" id="profile-title">
        Profile
      </h2>
      {children}
    </section>
  );
}

function PreferencesSection({ children }: { children: ReactNode }) {
  return (
    <section className="e-section" aria-labelledby="preferences-title">
      <h2 className="e-section__title" id="preferences-title">
        Preferences
      </h2>
      <div>{children}</div>
    </section>
  );
}

function PreferenceRow({ title, status, children }: { title: string; status: ReactNode; children: ReactNode }) {
  return (
    <div className="e-setting-row">
      <div className="e-setting-row__text">
        <p className="e-setting-row__title">{title}</p>
        {status}
      </div>
      <div className="e-setting-row__control">
        <div className="e-input e-select">
          {children}
          <Icon name="chevron-down" size="sm" />
        </div>
      </div>
    </div>
  );
}

/** Skeletons in the exact place of the fields while the account and its settings are read. */
function LoadingProfile() {
  return (
    <LoadingRegion label="Loading your settings">
      <div className="e-stack e-stack--section">
        <ProfileSection>
          <div className="e-grid-fields">
            {["Full name", "Email address"].map((label) => (
              <div className="e-field" key={label}>
                <span className="e-field__label">{label}</span>
                <Skeleton shape="block" />
              </div>
            ))}
          </div>
        </ProfileSection>
        <PreferencesSection>
          {["Time zone", "Date format"].map((title) => (
            <div className="e-setting-row" key={title}>
              <div className="e-setting-row__text">
                <p className="e-setting-row__title">{title}</p>
              </div>
              <div className="e-setting-row__control">
                <Skeleton shape="block" />
              </div>
            </div>
          ))}
        </PreferencesSection>
      </div>
    </LoadingRegion>
  );
}
