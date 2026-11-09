"use client";

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";
import { Icon } from "@/components/ui/icon";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { ProjectNameEntry } from "@/domain/project-naming";
import { CandidateAvailability } from "./candidate-availability";
import styles from "./naming-inspect.module.css";

type Props = {
  account: VerifiedAccount;
  entry: ProjectNameEntry;
  selected: boolean;
  pending: boolean;
  blocked: boolean;
  error?: string | null;
  earlierConfirmation: ReactNode;
  onClose: () => void;
  onRefresh: () => void;
  onUse: () => void;
  onSave: () => void;
  onFavorite: () => void;
  onSteering?: () => void;
  steeringSelected: boolean;
  steeringDisabled: boolean;
};

export function NamingInspect({ account, entry, selected, pending, blocked, error, earlierConfirmation, onClose,
  onRefresh, onUse, onSave, onFavorite, onSteering, steeringSelected, steeringDisabled }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { candidate, retention } = entry;
  const name = candidate.value;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    // Start on the dialog itself so opening never paints a focus ring on the first tab.
    element.focus({ preventScroll: true });
    return () => element.close();
  }, []);

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} tabIndex={-1}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (isDialogBackdropClick(event)) onClose(); }}>
    <header className={styles.header}>
      <div className={styles.identity}>
        {candidate.origin.kind === "brainstorm" && <p className={styles.label}>Unchecked brainstorm</p>}
        <h2 className={styles.title} id={titleId}>{name}</h2>
        {candidate.rationale && <p className={styles.rationale}>{candidate.rationale}</p>}
      </div>
      <div className={styles.headerActions}>
        <button type="button" className={styles.iconButton} aria-label={`${retention.favorite ? "Unfavorite" : "Favorite"} ${name}`}
          aria-pressed={retention.favorite} disabled={pending} onClick={onFavorite}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/naming/heart.svg" width={16} height={16} alt="" aria-hidden="true" />
        </button>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close name preview"><Icon name="close" size={18} /></button>
      </div>
    </header>
    <div className={styles.content}>
      <CandidateAvailability name={name} account={account} />
      {error && <div className="project-naming-notice" role="alert"><p>{error}</p><button type="button" className="text-link" disabled={pending} onClick={onRefresh}>Check latest version</button></div>}
    </div>
    {earlierConfirmation && <div className={styles.confirmation}>{earlierConfirmation}</div>}
    <div className={styles.footer}>
      <details className={styles.options}>
        <summary>More actions<Icon name="chevron" size={14} /></summary>
        <div className={styles.actions}>
          <button type="button" className="button secondary small" disabled={pending} aria-pressed={retention.saved} onClick={onSave}>{retention.saved ? "Unsave" : "Save"} {name}</button>
          {onSteering && <label className="naming-steering-choice"><input type="checkbox" checked={steeringSelected} disabled={steeringDisabled} onChange={onSteering} />More like this<span className="sr-only">: {name}</span></label>}
        </div>
      </details>
      <button type="button" className={`button ${selected ? "secondary" : "primary"} small`} disabled={pending || blocked || selected || Boolean(earlierConfirmation)} onClick={onUse}>
        {selected ? <><Icon name="check" size={14} />Selected name</> : "Use this name"}
      </button>
    </div>
  </dialog>;
}
