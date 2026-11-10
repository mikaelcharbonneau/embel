"use client";
import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { isDialogBackdropClick } from "./dialog-backdrop";
import styles from "./context-details.module.css";
/** Context lives in a readable sheet, not a tiny inline disclosure triangle.
 * Content stays mounted so draft state, pending saves and selections survive. */
export function ContextDetails({
  title,
  inline = false,
  children,
  className = "",
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "title"> & { title: ReactNode; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    heading = useId();
  useEffect(() => {
    if (inline) return;
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) {
      dialog.current.close();
      trigger.current?.focus();
    }
  }, [open, inline]);
  if (inline)
    return (
      <section {...props} className={`${className} ${styles.inline}`}>
        <h3>{title}</h3>
        {children}
      </section>
    );
  return (
    <section {...props} className={`${className} ${styles.root}`}>
      <button
        type="button"
        className={styles.trigger}
        ref={trigger}
        aria-haspopup="dialog"
        title={typeof title === "string" ? title : undefined}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span>{title}</span>
        <span aria-hidden="true">↗</span>
      </button>
      <dialog
        ref={dialog}
        className={styles.sheet}
        aria-labelledby={heading}
        onCancel={() => setOpen(false)}
        onClose={(event) => {
          if (!event.currentTarget.open) setOpen(false);
        }}
        onClick={(event) => {
          if (isDialogBackdropClick(event)) setOpen(false);
        }}
      >
        <header>
          <h2 id={heading}>{title}</h2>
          <button type="button" className="button secondary small" onClick={() => setOpen(false)}>
            Close
          </button>
        </header>
        <div className={styles.content}>{children}</div>
      </dialog>
    </section>
  );
}
