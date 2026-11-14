"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import type { AccountWorkspace } from "./account-draft-memory";
import type { DraftPatch } from "./project-editor";
import { personalityReviewKey, positioningReviewKey } from "./project-draft-adapter";
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
  function update(patch: DraftPatch) {
    if (readOnly) return;
    const next = { ...workspace.draft, ...patch };
    onUpdate({
      ...patch,
      ...(personalityReviewKey(workspace.draft) !== personalityReviewKey(next)
        ? { personalityReviewKey: null, personalityReviewedAt: null }
        : {}),
      ...(positioningReviewKey(workspace.draft) !== positioningReviewKey(next)
        ? { positioningReviewKey: null, positioningReviewedAt: null }
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
              value={workspace.draft.title}
              maxLength={160}
              readOnly={readOnly}
              onChange={(event) => update({ title: event.target.value })}
            />
          </label>
          <label className="field-label">
            Brief description
            <textarea
              value={workspace.draft.description}
              maxLength={12000}
              readOnly={readOnly}
              onChange={(event) =>
                update({
                  description: event.target.value,
                  confirmedBrief: undefined,
                  competitorReviewKey: null,
                  audienceReviewedAt: null,
                  audienceConversationKey: null,
                })
              }
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
                value={workspace.draft[field]}
                maxLength={2000}
                readOnly={readOnly}
                onChange={(event) =>
                  update({
                    [field]: event.target.value,
                    confirmedBrief: undefined,
                    competitorReviewKey: null,
                    audienceReviewedAt: null,
                    audienceConversationKey: null,
                  })
                }
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
