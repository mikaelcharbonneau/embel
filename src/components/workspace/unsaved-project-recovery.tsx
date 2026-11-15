"use client";

import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { useEffect, useState } from "react";
import { AccountStatus, useAccountSession } from "./account-session";
import { AccountCopyControl } from "./account-projects";
import { draftTitle, useLocalDrafts } from "./local-drafts";

const UNREADABLE = "Recovery data on this device couldn’t be read.";

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
  const eligible = drafts.filter(
    (draft) => (!draftId || draft.id === draftId) && (!draft.ownerId || draft.ownerId === ownerId),
  );
  const pending = eligible.filter((draft) => !draft.accountProjectId);
  const chosen = eligible.find((draft) => draft.id === selected);
  const recovered = draftId ? eligible.find((draft) => draft.accountProjectId) : null;
  const unreadable = storage === "invalid" || storage === "unavailable";
  if (!loaded) return <p role="status">Checking recovery availability…</p>;
  if (recovered)
    return (
      <EmptyState
        icon="circle-check"
        title="This project is saved in your account"
        action={
          <ButtonLink variant="primary" href={`/brands/account/${recovered.accountProjectId}`} arrow>
            Open project
          </ButtonLink>
        }
      />
    );
  if (!pending.length)
    return draftId ? (
      <EmptyState
        title="No unsaved project to recover"
        text={unreadable ? UNREADABLE : undefined}
        action={
          <ButtonLink variant="primary" href="/brands" icon="arrow-left">
            Back to projects
          </ButtonLink>
        }
      />
    ) : unreadable ? (
      <p className="field-hint">{UNREADABLE}</p>
    ) : null;
  return (
    <section className="account-edit-controls" aria-label="Recover unsaved projects" id="recover-unsaved-projects">
      {!opened ? (
        <button className="text-link" type="button" onClick={() => setOpened(true)}>
          Recover unsaved projects
        </button>
      ) : (
        <>
          <h2>Recover unsaved projects</h2>
          <fieldset>
            <legend>Select a project to recover</legend>
            {pending.map((draft) => (
              <label key={draft.id} className="scope-option">
                <input
                  type="radio"
                  name="recover-project"
                  value={draft.id}
                  checked={selected === draft.id}
                  onChange={() => {
                    setSelected(draft.id);
                    setConfirmed(false);
                  }}
                />
                <span>
                  <strong>{draftTitle(draft)}</strong>
                </span>
              </label>
            ))}
          </fieldset>
          {chosen && (
            <>
              <p>{chosen.description}</p>
              <label className="scope-option">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>This is my project, and I want to save it to the account I’m currently signed in to.</span>
              </label>
              {confirmed && <AccountCopyControl key={chosen.id} draft={chosen} />}
            </>
          )}
          <button
            className="text-link"
            type="button"
            onClick={() => {
              setOpened(false);
              setSelected(null);
              setConfirmed(false);
            }}
          >
            Close recovery
          </button>
        </>
      )}
    </section>
  );
}
