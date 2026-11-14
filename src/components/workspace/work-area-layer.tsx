"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Where a dialog about the work opens. With a Workspace overlay host it opens there, over the work area only, and
 * is not modal, so the chat beside it stays usable; Escape closes the topmost one. Without a host the dialog is an
 * ordinary modal dialog (its own Escape handling applies).
 */
export function WorkAreaLayer({
  host,
  onEscape,
  children,
}: {
  host: HTMLElement | null | undefined;
  onEscape: () => void;
  children: ReactNode;
}) {
  if (!host) return <>{children}</>;
  return createPortal(
    <div
      className="e-workspace__overlay"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }}
    >
      {children}
    </div>,
    host,
  );
}
