"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { IconButton } from "@/components/ui/button";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";

export function SignInDialog({
  children,
  mode = "sign-in",
}: {
  children: React.ReactNode;
  mode?: "sign-in" | "sign-up";
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement;
    element.showModal();
    element.querySelector<HTMLButtonElement>(".auth-overlay__close")?.focus();
    return () => {
      element.close();
      // Route effects can close the account menu while the overlay closes.
      // Restore after those effects, and never focus its now-hidden sign-in link.
      // A signed-out "Sign in" opener becomes the account menu once sign-in
      // starts, so fall back to whichever account control the pill shows now.
      requestAnimationFrame(() => {
        if (document.querySelector("dialog[open]")) return;
        const currentAccountControl = document.querySelector<HTMLElement>(
          '.e-nav [data-account-menu-trigger], .e-nav a[href="/sign-in"]',
        );
        const target = [previous instanceof HTMLElement ? previous : null, currentAccountControl].find(
          (candidate) =>
            candidate?.isConnected &&
            candidate.getClientRects().length > 0 &&
            !candidate.closest("details:not([open]) > :not(summary)") &&
            (candidate.checkVisibility?.() ?? true) &&
            !candidate.closest("[hidden], [inert]") &&
            !candidate.matches(":disabled") &&
            getComputedStyle(candidate).visibility !== "hidden",
        );
        target?.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="e-dialog e-dialog--sm auth-overlay"
      aria-labelledby="auth-overlay-title"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]"),
        ).filter(
          (element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0,
        );
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        router.back();
      }}
      onClick={(event) => {
        if (isDialogBackdropClick(event)) router.back();
      }}
    >
      <IconButton
        className="auth-overlay__close"
        icon="x"
        label={mode === "sign-up" ? "Close account creation" : "Close sign-in"}
        tooltip={false}
        onClick={() => router.back()}
      />
      {children}
    </dialog>
  );
}
