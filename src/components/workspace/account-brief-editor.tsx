"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import type { AccountWorkspace } from "./account-draft-memory";
import type { DraftPatch } from "./project-editor";
import {
  competitorReviewKey,
  isCompetitorReviewComplete,
  isPersonalityReviewComplete,
  isPositioningReviewComplete,
  personalityReviewKey,
  positioningReviewKey,
} from "./project-draft-adapter";
import { IconButton } from "@/components/ui/button";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";
import styles from "@/components/ui/context-details.module.css";

/** Edits the current brief, never the immutable text of earlier messages. */
export function AccountBriefEditor({
  workspace,
  open,
  onOpen,
  onClose,
  readOnly,
  saveLabel,
  onUpdate,
  navigation,
}: {
  workspace: AccountWorkspace;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  navigation?: ReactNode;
  readOnly: boolean;
  saveLabel: string;
  onUpdate: (patch: DraftPatch) => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const heading = useId();
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) {
      dialog.current.close();
      trigger.current?.focus();
    }
  }, [open]);
  /** Owner decision, November 14, 2026: editing the brief keeps the confirmed Strategy answers and closes no
   * later step. Each confirmation is tied to the exact brief it was made for, so an edit carries every one that
   * held before it over to the new text. The conversation then says the brief changed and offers a redo
   * (`briefChangedSinceStrategy`). An emptied description still cannot proceed; that is decided where it is read. */
  function update(patch: DraftPatch) {
    if (readOnly) return;
    const before = workspace.draft,
      saved = workspace.saved.context,
      next = { ...before, ...patch };
    const brief = before.confirmedBrief;
    const briefConfirmed =
      brief &&
      (["description", "activity", "offering", "knownAudience"] as const).every(
        (key) => brief[key].trim() === before[key].trim(),
      );
    onUpdate({
      ...patch,
      ...(briefConfirmed
        ? {
            confirmedBrief: {
              ...brief,
              description: next.description,
              activity: next.activity,
              offering: next.offering,
              knownAudience: next.knownAudience,
            },
          }
        : {}),
      ...(isCompetitorReviewComplete(before, saved) ? { competitorReviewKey: competitorReviewKey(next, saved) } : {}),
      ...(isPersonalityReviewComplete(before, saved)
        ? { personalityReviewKey: personalityReviewKey(next, saved) }
        : {}),
      ...(isPositioningReviewComplete(before, saved)
        ? { positioningReviewKey: positioningReviewKey(next, saved) }
        : {}),
    });
  }
  return (
    <div className="guided-brief-editor">
      <IconButton
        ref={trigger}
        icon="pencil"
        label="Edit brief"
        size="sm"
        className="brief-edit-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onOpen}
      />
      <dialog
        ref={dialog}
        className={styles.sheet}
        aria-labelledby={heading}
        onCancel={onClose}
        onClose={(event) => {
          if (!event.currentTarget.open) onClose();
        }}
        onClick={(event) => {
          if (isDialogBackdropClick(event)) onClose();
        }}
      >
        <header>
          <h2 id={heading}>Edit current brief</h2>
          <button type="button" className="button secondary small" onClick={onClose}>
            Close
          </button>
        </header>
        <div className={styles.content}>
          <p>
            Changes save to this project. Earlier conversation messages stay unchanged. This does not start AI research.
          </p>
          <p role="status">{saveLabel}</p>
          <label className="field-label">
            Project label
            <input
              name="title"
              autoComplete="off"
              value={workspace.draft.title}
              maxLength={160}
              readOnly={readOnly}
              onChange={(event) => update({ title: event.target.value })}
            />
          </label>
          <label className="field-label">
            Brief description
            <textarea
              name="description"
              autoComplete="off"
              value={workspace.draft.description}
              maxLength={12000}
              readOnly={readOnly}
              onChange={(event) => update({ description: event.target.value })}
            />
          </label>
          {(
            [
              ["activity", "What the business does"],
              ["offering", "First products / services"],
              ["knownAudience", "Known audience"],
            ] as const
          ).map(([field, label]) => (
            <label className="field-label" key={field}>
              {label}
              <input
                name={field}
                autoComplete="off"
                value={workspace.draft[field]}
                maxLength={2000}
                readOnly={readOnly}
                onChange={(event) => update({ [field]: event.target.value })}
              />
            </label>
          ))}
          {navigation}
          {workspace.conflict && (
            <p role="alert">
              A newer version is saved. Close this editor to review the saved-version conflict; your edits are retained.
            </p>
          )}
          {workspace.pendingDraftSave && saveLabel === "Changes not saved" && (
            <p>Close this editor to check and retry the original save.</p>
          )}
        </div>
      </dialog>
    </div>
  );
}
