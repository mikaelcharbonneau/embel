"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon";

type Toast = { id: number; message: string; action?: { label: string; onSelect: () => void } };
type Show = (message: string, action?: Toast["action"]) => void;

const ToastContext = createContext<Show | null>(null);
/** The design system's toast-duration token (5 s). */
const DURATION_MS = 5000;

/**
 * A brief neutral confirmation for a result the person cannot see where they are looking: copied, downloaded,
 * moved to Deleted. One at a time, announced politely, paused while hovered or focused. Never for errors.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [paused, setPaused] = useState(false);
  const next = useRef(0);
  const show = useCallback<Show>((message, action) => setToast({ id: ++next.current, message, action }), []);

  useEffect(() => {
    if (!toast || paused) return;
    const timer = window.setTimeout(() => setToast(null), DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast, paused]);

  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="e-toast-region e-on-inverse" role="status" aria-live="polite">
        {toast ? (
          <div
            key={toast.id}
            className="e-toast"
            onPointerEnter={() => setPaused(true)}
            onPointerLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
          >
            <span className="e-toast__text">{toast.message}</span>
            {toast.action ? (
              <button
                type="button"
                className="e-toast__action"
                onClick={() => {
                  toast.action?.onSelect();
                  setToast(null);
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
            <button type="button" className="e-toast__close" aria-label="Dismiss" onClick={() => setToast(null)}>
              <Icon name="x" size="sm" />
            </button>
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

/** Shows a toast: `toast("Brand kit downloaded")`, or with an action: `toast("Moved to Deleted", { label: "Undo", onSelect })`. */
export function useToast(): Show {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast needs a ToastProvider above it.");
  return show;
}
