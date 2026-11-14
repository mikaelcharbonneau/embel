"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./button";
import { isDialogBackdropClick } from "./dialog-backdrop";
import styles from "./dialog.module.css";

export type DialogSize = "sm" | "md" | "lg" | "xl";

/**
 * A native dialog for one decision or one focused view. Render it only while it is open: it opens with showModal()
 * on mount (focus moves in and is trapped), closes on Escape, the close button or a backdrop press, and returns
 * focus to whatever had it before. While `busy`, it cannot be dismissed so a running action finishes in view.
 * `modal={false}` is for dialogs about the work in the Workspace: they open in the work-area overlay and leave the
 * chat usable.
 */
export function Dialog({
  title,
  description,
  size = "md",
  onClose,
  busy = false,
  modal = true,
  footer,
  media = false,
  closeLabel = "Close",
  aside,
  actions,
  className,
  children,
}: {
  title: ReactNode;
  /** One sentence under the title, read as the dialog's description. */
  description?: ReactNode;
  size?: DialogSize;
  onClose: () => void;
  busy?: boolean;
  modal?: boolean;
  /** Actions, right-aligned with the primary action last. */
  footer?: ReactNode;
  /** A body that holds a large picture. */
  media?: boolean;
  closeLabel?: string;
  /** A badge beside the title, outside its accessible name. */
  aside?: ReactNode;
  /** Icon buttons before Close in the header, such as a heart. */
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const ids = { title: useId(), description: useId() };
  const close = useRef(onClose);
  const blocked = useRef(busy);
  useEffect(() => {
    close.current = onClose;
    blocked.current = busy;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      if (modal) dialog.showModal();
      else dialog.show();
    }
    return () => {
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [modal]);

  const dismiss = () => {
    if (!blocked.current) close.current();
  };
  const classes = ["e-dialog", size === "md" ? "" : `e-dialog--${size}`, className].filter(Boolean).join(" ");
  return (
    <dialog
      ref={ref}
      className={classes}
      aria-labelledby={ids.title}
      aria-describedby={description ? ids.description : undefined}
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (modal && isDialogBackdropClick(event)) dismiss();
      }}
    >
      <header className="e-dialog__header">
        <div className="e-stack e-stack--xs">
          {aside ? (
            <div className="e-cluster">
              <h2 className="e-dialog__title" id={ids.title}>
                {title}
              </h2>
              {aside}
            </div>
          ) : (
            <h2 className="e-dialog__title" id={ids.title}>
              {title}
            </h2>
          )}
          {description ? (
            <p className="e-muted" id={ids.description}>
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className={styles.actions}>
            {actions}
            <IconButton
              icon="x"
              label={closeLabel}
              tooltip={false}
              aria-disabled={busy || undefined}
              onClick={dismiss}
            />
          </div>
        ) : (
          <IconButton icon="x" label={closeLabel} tooltip={false} aria-disabled={busy || undefined} onClick={dismiss} />
        )}
      </header>
      <div className={media ? "e-dialog__body e-dialog__body--media" : "e-dialog__body"}>{children}</div>
      {footer ? <footer className="e-dialog__footer">{footer}</footer> : null}
    </dialog>
  );
}
