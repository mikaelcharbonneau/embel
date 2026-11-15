"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { onOutOfCredits } from "./out-of-credits";
import "@/styles/plans.css";

/** Shown wherever a step was refused for lack of credits. The step's own message still says
 * when the credits renew and what is kept; this offers the plans. Never a cost estimate. */
export function OutOfCreditsPrompt({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => onOutOfCredits(() => setOpen(true)), []);
  // Reaching the Plans page answers the prompt.
  if (open && pathname === "/plans") setOpen(false);
  if (!open || pathname === "/plans") return null;
  return (
    <aside className="out-of-credits-prompt" role="status" aria-live="polite" aria-label="Out of credits">
      <strong className="out-of-credits-title">You’re out of credits for this month</strong>
      <div className="out-of-credits-actions">
        <button type="button" className="button secondary small" onClick={() => setOpen(false)}>
          Not now
        </button>
        <Link className="button primary small" href="/plans" onClick={() => setOpen(false)}>
          See plans
        </Link>
      </div>
    </aside>
  );
}
