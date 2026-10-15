"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountStatus, useAccountSession } from "./account-session";
import { AccountCopyControl } from "./account-projects";
import { draftTitle, scopeLabel, useLocalDrafts } from "./local-drafts";

/** Legacy device content is revealed only by an explicit recovery action. */
export function UnsavedProjectRecovery({ draftId }: { draftId?: string }) {
  const { session } = useAccountSession();
  if (session.status !== "ready") return <AccountStatus />;
  return <OwnedRecovery key={`${session.userId}:${session.generation}`} ownerId={session.userId} draftId={draftId} />;
}

function OwnedRecovery({ ownerId, draftId }: { ownerId: string; draftId?: string }) {
  const { drafts, loaded, storage } = useLocalDrafts();
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("recover") === "1") {
      // An explicit Settings recovery link opens the picker; no upload starts.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpened(true);
    }
  }, []);
  const eligible = drafts.filter(draft => (!draftId || draft.id === draftId) && (!draft.ownerId || draft.ownerId === ownerId));
  const pending = eligible.filter(draft => !draft.accountProjectId);
  const chosen = eligible.find(draft => draft.id === selected);
  const recovered = draftId ? eligible.find(draft => draft.accountProjectId) : null;
  if (!loaded) return <p role="status">Checking recovery availability…</p>;
  if (recovered) return <p>This project is saved in your account. <Link className="text-link" href={`/brands/account/${recovered.accountProjectId}`}>Open project</Link></p>;
  if (!pending.length) return draftId ? <p>No unsaved project is available for this account. <Link className="text-link" href="/brands">Back to projects</Link></p> : storage === "invalid" || storage === "unavailable" ? <p className="field-hint">Recovery data on this device could not be read. Your account projects remain available.</p> : null;
  return <section className="account-edit-controls" aria-label="Recover unsaved projects" id="recover-unsaved-projects">
    {!opened ? <button className="text-link" type="button" onClick={() => setOpened(true)}>Recover unsaved projects</button> : <>
      <h2>Recover unsaved projects</h2>
      <p>Older projects may still be on this device. Select only work that belongs to you, then confirm it should be saved to your current account.</p>
      <fieldset><legend>Select a project to recover</legend>{pending.map(draft => <label key={draft.id} className="scope-option"><input type="radio" name="recover-project" value={draft.id} checked={selected === draft.id} onChange={() => { setSelected(draft.id); setConfirmed(false); }} /><span><strong>{draftTitle(draft)}</strong><span>{scopeLabel(draft.scope)}</span></span></label>)}</fieldset>
      {chosen && <><p>{chosen.description}</p><label className="scope-option"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>This is my project, and I want to save it to the account I’m currently signed in to.</span></label>{confirmed && <AccountCopyControl key={chosen.id} draft={chosen} />}</>}
      <button className="text-link" type="button" onClick={() => { setOpened(false); setSelected(null); setConfirmed(false); }}>Close recovery</button>
    </>}
  </section>;
}
