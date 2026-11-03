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
  onWorkshop: () => void;
  onSave: () => void;
  onFavorite: () => void;
  onSteering?: () => void;
  steeringSelected: boolean;
  steeringDisabled: boolean;
};

export function NamingInspect({ account, entry, selected, pending, blocked, error, earlierConfirmation, onClose,
  onRefresh, onUse, onWorkshop, onSave, onFavorite, onSteering, steeringSelected, steeringDisabled }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const name = entry.candidate.value;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (isDialogBackdropClick(event)) onClose(); }}>
    <header className={styles.header}>
      <div><p className={styles.label}>Name availability</p><h2 className={styles.title} id={titleId}>{name}</h2></div>
      <button type="button" className={styles.close} onClick={onClose} aria-label="Close name preview"><Icon name="close" size={18} /></button>
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
          <button type="button" className="button secondary small" disabled={pending} aria-pressed={entry.retention.favorite} onClick={onFavorite}>{entry.retention.favorite ? "Unfavorite" : "Favorite"} {name}</button>
          <button type="button" className="button secondary small" disabled={pending} aria-pressed={entry.retention.saved} onClick={onSave}>{entry.retention.saved ? "Unsave" : "Save"} {name}</button>
          <button type="button" className="button secondary small" disabled={pending || blocked} onClick={onWorkshop}>Explore variations</button>
          {onSteering && <label className="naming-steering-choice"><input type="checkbox" checked={steeringSelected} disabled={steeringDisabled} onChange={onSteering} />More like this<span className="sr-only">: {name}</span></label>}
        </div>
      </details>
      <button type="button" className="button secondary small" disabled={pending || blocked || selected || Boolean(earlierConfirmation)} onClick={onUse}>{selected ? "Selected name" : "Use this name"}</button>
    </div>
  </dialog>;
}
